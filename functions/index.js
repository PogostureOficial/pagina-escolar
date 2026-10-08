const { onSchedule } = require('firebase-functions/v2/scheduler');
const { initializeApp } = require('firebase-admin/app');
const { getDatabase } = require('firebase-admin/database');

initializeApp();

const ROUND_MS = 5 * 60 * 1000;
const ECONOMY_POINT_VALUE = 12500;
const PROVINCES = [
  { id: 'ba', stats: { Población: 10, Economía: 10, Necesidad: 8, Infraestructura: 6, Recursos: 8, 'Influencia política': 10, Gestión: 5 } },
  { id: 'co', stats: { Población: 8, Economía: 8, Necesidad: 5, Infraestructura: 7, Recursos: 6, 'Influencia política': 7, Gestión: 8 } },
  { id: 'me', stats: { Población: 6, Economía: 7, Necesidad: 5, Infraestructura: 6, Recursos: 8, 'Influencia política': 6, Gestión: 7 } },
  { id: 'sa', stats: { Población: 6, Economía: 5, Necesidad: 8, Infraestructura: 5, Recursos: 8, 'Influencia política': 5, Gestión: 6 } },
  { id: 'mi', stats: { Población: 6, Economía: 6, Necesidad: 7, Infraestructura: 5, Recursos: 7, 'Influencia política': 5, Gestión: 6 } },
  { id: 'tf', stats: { Población: 2, Economía: 6, Necesidad: 6, Infraestructura: 5, Recursos: 7, 'Influencia política': 4, Gestión: 6 } },
];
const BASE_CAPITALS = Object.fromEntries(PROVINCES.map(({ id, stats }) => [id, stats.Economía * ECONOMY_POINT_VALUE]));

function deriveNeed(stats) {
  const keys = ['Población', 'Economía', 'Infraestructura', 'Recursos', 'Influencia política', 'Gestión'];
  const sum = keys.reduce((total, key) => total + (Number(stats[key]) || 0), 0);
  return Math.max(0, Math.min(10, Math.floor((60 - sum) / 6)));
}

function maxHealth(level) { return Number(level) >= 2 ? 25 : 10; }

function createRainSchedule(roundStartedAt, round) {
  const events = round <= 1 ? [] : [{ offset: 0, duration: 60000 }];
  return { roundStartedAt, events };
}

function tickRoom(raw, now) {
  if (!raw || raw.ended) return raw;
  const round = Math.min(Number(raw.round ?? raw.drawn?.length ?? 0), 10);
  const roundStartedAt = Number(raw.roundStartedAt) || 0;
  if (!round || !roundStartedAt) return raw;

  const roundEnd = roundStartedAt + ROUND_MS;
  const targetAt = Math.min(now, roundEnd);
  const from = Math.max(roundStartedAt, Math.min(Number(raw.serverSimulationAt) || roundStartedAt, targetAt));
  const incomeFrom = Math.max(from, Math.min(Number(raw.houseIncomeAt) || roundStartedAt, targetAt));
  if (targetAt <= from && raw.serverSimulationVersion >= 1) return raw;

  const state = { ...raw };
  const layouts = { ...(state.houseLayouts || {}) };
  const levels = { ...(state.houseLevels || {}) };
  const health = { ...(state.houseHealth || {}) };
  const damageAt = { ...(state.acidHouseDamageAt || {}) };
  const schedules = { ...(state.acidRainSchedules || {}) };
  let changed = false;
  for (const { id } of PROVINCES) {
    const expectedEvents = round <= 1 ? 0 : 1;
    if (Number(schedules[id]?.roundStartedAt) !== roundStartedAt || !Array.isArray(schedules[id]?.events) || schedules[id].events.length !== expectedEvents || (round > 1 && (Number(schedules[id].events[0]?.offset) !== 0 || Number(schedules[id].events[0]?.duration) !== 60000))) {
      schedules[id] = createRainSchedule(roundStartedAt, round);
      changed = true;
    }
  }
  const capitals = { ...BASE_CAPITALS, ...(state.capitals || {}) };
  const stats = { ...(state.stats || {}) };
  const incomeEvents = { ...(state.houseIncomeEvents || {}) };
  const random = Math.random;

  for (const province of PROVINCES) {
    const id = province.id;
    const spots = Array.isArray(layouts[id]) ? [...layouts[id]] : [];
    const houseLevels = Array.isArray(levels[id]) ? [...levels[id]] : spots.map(() => 1);
    const houseHealth = Array.isArray(health[id]) ? [...health[id]] : spots.map((_, i) => maxHealth(houseLevels[i]));
    const events = Number(schedules[id]?.roundStartedAt) === roundStartedAt && Array.isArray(schedules[id]?.events) ? schedules[id].events : [];
    let cursor = incomeFrom;
    const accrueTo = (at) => {
      const end = Math.min(at, roundEnd);
      const seconds = Math.floor((end - cursor) / 1000);
      if (seconds <= 0) return;
      const rate = houseLevels.reduce((sum, level, index) => sum + (Number(houseHealth[index]) > 0 ? (Number(level) >= 2 ? 250 : 125) : 0), 0);
      if (rate) {
        capitals[id] = (Number(capitals[id]) || 0) + rate * seconds;
        const provinceStats = { ...(stats[id] || province.stats) };
        provinceStats.Economía = Math.floor(capitals[id] / ECONOMY_POINT_VALUE);
        provinceStats.Recursos = (Number(provinceStats.Infraestructura) || 0) + provinceStats.Economía;
        const excess = Math.max(0, capitals[id] - (BASE_CAPITALS[id] || 0));
        provinceStats.Gestión = Math.max(0, (Number(state.managementBase?.[id]) || province.stats.Gestión) - Math.floor(excess / ECONOMY_POINT_VALUE));
        provinceStats.Necesidad = deriveNeed(provinceStats);
        stats[id] = provinceStats;
        incomeEvents[id] = { amount: rate, total: rate * seconds, seconds, at: cursor + seconds * 1000 };
        changed = true;
      }
      cursor += seconds * 1000;
    };

    const hits = [];
    for (const event of events) {
      const eventStart = roundStartedAt + Number(event.offset);
      const eventEnd = Math.min(eventStart + Number(event.duration), roundEnd);
      let lastDamage = Math.max(Number(damageAt[id]) || 0, eventStart);
      let due = lastDamage + 1000;
      while (due <= eventEnd && due <= targetAt) {
        if (due > from) hits.push(due);
        lastDamage = due;
        due += 1000;
      }
    }
    hits.sort((a, b) => a - b);

    for (const hitAt of hits) {
      accrueTo(hitAt);
      const candidates = spots.map((_, index) => index).filter(index => Number(houseHealth[index]) > 0);
      damageAt[id] = hitAt;
      changed = true;
      if (candidates.length) {
        const index = candidates[Math.floor(random() * candidates.length)];
        houseHealth[index] = Math.max(0, Number(houseHealth[index]) - 1);
        if (houseHealth[index] === 0) {
          const contribution = Number(houseLevels[index]) >= 2 ? 2 : 1;
          const provinceStats = { ...(stats[id] || province.stats) };
          provinceStats.Población = Math.max(0, (Number(provinceStats.Población) || 0) - contribution);
          provinceStats.Infraestructura = Math.max(0, (Number(provinceStats.Infraestructura) || 0) - contribution);
          provinceStats.Recursos = (Number(provinceStats.Infraestructura) || 0) + (Number(provinceStats.Economía) || 0);
          provinceStats.Necesidad = deriveNeed(provinceStats);
          stats[id] = provinceStats;
          spots.splice(index, 1);
          houseLevels.splice(index, 1);
          houseHealth.splice(index, 1);
        }
      }
    }
    accrueTo(targetAt);
    const infrastructure = houseLevels.reduce((sum, level, index) => sum + (Number(houseHealth[index]) > 0 ? (Number(level) >= 2 ? 2 : 1) : 0), 0);
    const provinceStats = { ...(stats[id] || province.stats) };
    if (Number(provinceStats.Infraestructura) !== infrastructure) changed = true;
    provinceStats.Infraestructura = infrastructure;
    provinceStats.Recursos = infrastructure + (Number(provinceStats.Economía) || 0);
    provinceStats.Necesidad = deriveNeed(provinceStats);
    stats[id] = provinceStats;
    layouts[id] = spots;
    levels[id] = houseLevels;
    health[id] = houseHealth;
  }

  if (!changed && state.serverSimulationVersion >= 1) return raw;
  return {
    ...state,
    houseLayouts: layouts,
    houseLayoutsInitialized: Object.fromEntries(PROVINCES.map(({ id }) => [id, true])),
    houseLevels: levels,
    houseHealthVersion: 1,
    houseHealth: health,
    acidHouseDamageAt: damageAt,
    stats,
    capitals,
    houseIncomeAt: targetAt,
    houseIncomeEvents: incomeEvents,
    serverSimulationVersion: 1,
    serverSimulationAt: Math.max(from, targetAt),
  };
}

exports.advanceProvinceGames = onSchedule({ schedule: 'every 1 minutes', timeZone: 'Etc/UTC', retryCount: 3 }, async () => {
  const roomsSnapshot = await getDatabase().ref('salas').get();
  if (!roomsSnapshot.exists()) return;
  const now = Date.now();
  const updates = [];
  roomsSnapshot.forEach(roomSnapshot => {
    const roomRef = roomSnapshot.ref;
    updates.push(roomRef.transaction(current => tickRoom(current, now), undefined, false));
  });
  await Promise.all(updates);
});

exports._test = { tickRoom, deriveNeed };
