'use strict';

const fs = require('fs');
const path = require('path');

const REFRESH_INTERVAL_MS = 30 * 60 * 1000;
const CACHE_TTL_MS = 30 * 60 * 1000;
const STALE_CACHE_MS = 6 * 60 * 60 * 1000;
const REQUEST_TIMEOUT_MS = 8 * 1000;
const RETRY_DELAYS_MS = [5, 15, 30, 60].map((minutes) => minutes * 60 * 1000);
const CHINA_LOCATION_INDEX = path.join(
  __dirname,
  'assets',
  'location',
  'china-administrative.json'
);
let chinaLocationRecords = null;

function readJson(filePath, fallback) {
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch {
    return fallback;
  }
}

function writeJson(filePath, value) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, JSON.stringify(value, null, 2), 'utf8');
}

function weatherStateFromCode(code) {
  const numericCode = Number(code);
  if (numericCode === 0) return 'clear';
  if ([1, 2, 3, 45, 48].includes(numericCode)) return 'cloudy';
  if ([51, 53, 55, 56, 57, 61, 63, 66, 80].includes(numericCode)) return 'rain';
  if ([65, 67, 81, 82].includes(numericCode)) return 'heavy_rain';
  if ([71, 73, 75, 77, 85, 86].includes(numericCode)) return 'snow';
  if ([95, 96, 99].includes(numericCode)) return 'thunder';
  return 'cloudy';
}

function weatherLabel(state) {
  return {
    clear: '晴朗',
    cloudy: '多云',
    rain: '有雨',
    heavy_rain: '大雨',
    snow: '有雪',
    thunder: '雷雨'
  }[state] || '天气不明';
}

function normalizeLocationName(value) {
  return String(value || '')
    .toLowerCase()
    .replace(/[\s,，、·/\\-]/g, '');
}

function locationAliases(value) {
  const normalized = normalizeLocationName(value);
  const short = normalized.replace(
    /(特别行政区|壮族自治区|回族自治区|维吾尔自治区|自治区|自治州|地区|省|市|区|县|旗)$/,
    ''
  );
  return [...new Set([normalized, short].filter((item) => item.length >= 2))];
}

function locationParts(record) {
  const parts = [record.province, record.city, record.district].filter(Boolean);
  return parts.filter((item, index) => index === 0 || item !== parts[index - 1]);
}

function locationLabel(record) {
  return locationParts(record).join('');
}

function getChinaLocationRecords() {
  if (chinaLocationRecords) return chinaLocationRecords;
  chinaLocationRecords = readJson(CHINA_LOCATION_INDEX, { records: [] }).records || [];
  return chinaLocationRecords;
}

function fieldMatchScore(query, value, weight) {
  if (!value) return 0;
  const aliases = locationAliases(value);
  if (aliases.some((alias) => query.includes(alias))) return weight;
  return 0;
}

function resolveChinaLocation(queryText) {
  const query = normalizeLocationName(queryText);
  if (query.length < 2) return null;
  const matches = [];
  for (const record of getChinaLocationRecords()) {
    const specificName = record.district || record.city || record.province;
    const specificMatched = locationAliases(specificName)
      .some((alias) => query.includes(alias) || alias.includes(query));
    if (!specificMatched) continue;
    const fullLabel = normalizeLocationName(locationLabel(record));
    let score = record.level === '区县' ? 300 : (record.level === '市' ? 200 : 100);
    if (query === fullLabel) score += 1000;
    if (fullLabel.includes(query) || query.includes(fullLabel)) score += 300;
    score += fieldMatchScore(query, record.province, 120);
    score += fieldMatchScore(query, record.city, 100);
    score += fieldMatchScore(query, record.district, 160);
    matches.push({ record, score });
  }
  if (!matches.length) return null;
  matches.sort((left, right) => right.score - left.score);
  const bestScore = matches[0].score;
  const best = matches.filter((item) => item.score === bestScore);
  const uniqueLabels = [...new Set(best.map((item) => locationLabel(item.record)))];
  if (uniqueLabels.length > 1) {
    const examples = uniqueLabels.slice(0, 3).join('、');
    throw new Error(`地点存在重名，请补充省市，例如：${examples}。`);
  }
  return best[0].record;
}

function geometryCenter(geometry) {
  const polygons = geometry?.type === 'Polygon'
    ? [geometry.coordinates]
    : (geometry?.type === 'MultiPolygon' ? geometry.coordinates : []);
  let weightedLongitude = 0;
  let weightedLatitude = 0;
  let totalArea = 0;
  const allPoints = [];
  for (const polygon of polygons) {
    const ring = polygon?.[0] || [];
    let twiceArea = 0;
    let longitudeNumerator = 0;
    let latitudeNumerator = 0;
    for (let index = 0; index < ring.length - 1; index += 1) {
      const current = ring[index];
      const next = ring[index + 1];
      if (!Array.isArray(current) || !Array.isArray(next)) continue;
      allPoints.push(current);
      const cross = current[0] * next[1] - next[0] * current[1];
      twiceArea += cross;
      longitudeNumerator += (current[0] + next[0]) * cross;
      latitudeNumerator += (current[1] + next[1]) * cross;
    }
    if (Math.abs(twiceArea) < 1e-10) continue;
    const area = Math.abs(twiceArea / 2);
    weightedLongitude += (longitudeNumerator / (3 * twiceArea)) * area;
    weightedLatitude += (latitudeNumerator / (3 * twiceArea)) * area;
    totalArea += area;
  }
  if (totalArea > 0) {
    return {
      longitude: weightedLongitude / totalArea,
      latitude: weightedLatitude / totalArea
    };
  }
  if (!allPoints.length) throw new Error('无法读取该行政区的坐标。');
  const longitudes = allPoints.map((point) => point[0]);
  const latitudes = allPoints.map((point) => point[1]);
  return {
    longitude: (Math.min(...longitudes) + Math.max(...longitudes)) / 2,
    latitude: (Math.min(...latitudes) + Math.max(...latitudes)) / 2
  };
}

function buildContext(settings, cache) {
  const current = cache?.current;
  if (!settings.enabled || !current || !cache.fetchedAt) return null;
  const ageMs = Date.now() - Number(cache.fetchedAt);
  if (ageMs > STALE_CACHE_MS) return null;
  const temperature = Number(current.temperature);
  const apparentTemperature = Number(current.apparentTemperature);
  const windSpeed = Number(current.windSpeed);
  const precipitation = Number(current.precipitation);
  const state = weatherStateFromCode(current.weatherCode);
  const hot = temperature >= 30 || apparentTemperature >= 32;
  const cold = temperature <= 8 || apparentTemperature <= 6;
  const windy = windSpeed >= 30;
  const signature = [
    state,
    hot ? 'hot' : '',
    cold ? 'cold' : '',
    windy ? 'windy' : '',
    Math.round(temperature / 3)
  ].join(':');
  return {
    city: settings.city,
    province: settings.province || '',
    district: settings.district || '',
    precision: settings.precision || 'city',
    latitude: settings.latitude,
    longitude: settings.longitude,
    timezone: settings.timezone,
    state,
    label: weatherLabel(state),
    temperature,
    apparentTemperature,
    precipitation,
    windSpeed,
    dailyMax: Number(cache.daily?.temperatureMax),
    dailyMin: Number(cache.daily?.temperatureMin),
    precipitationProbability: Number(cache.daily?.precipitationProbability),
    hot,
    cold,
    windy,
    severe: state === 'heavy_rain' || state === 'thunder',
    signature,
    fetchedAt: Number(cache.fetchedAt),
    stale: ageMs > CACHE_TTL_MS
  };
}

async function fetchJson(url, timeoutMs = REQUEST_TIMEOUT_MS) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(url, {
      signal: controller.signal,
      headers: { 'User-Agent': 'YukinoDesktopPet/1.4.0-rc1' }
    });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    return await response.json();
  } finally {
    clearTimeout(timeout);
  }
}

function createWeatherService({ app, onUpdate = () => {} }) {
  const settingsPath = path.join(app.getPath('userData'), 'weather-settings.json');
  const cachePath = path.join(app.getPath('userData'), 'weather-cache.json');
  let settings = readJson(settingsPath, {
    enabled: false,
    city: '',
    latitude: null,
    longitude: null,
    timezone: 'auto'
  });
  let cache = readJson(cachePath, null);
  let refreshTimer = null;
  let retryTimer = null;
  let retryIndex = 0;
  let updating = false;
  let lastError = '';

  function saveSettings() {
    writeJson(settingsPath, settings);
  }

  function scheduleRetry() {
    if (retryTimer || !settings.enabled) return;
    const delay = RETRY_DELAYS_MS[Math.min(retryIndex, RETRY_DELAYS_MS.length - 1)];
    retryIndex += 1;
    retryTimer = setTimeout(() => {
      retryTimer = null;
      refresh(true).catch(() => {});
    }, delay);
  }

  async function refresh(force = false) {
    if (!settings.enabled || !Number.isFinite(settings.latitude)
      || !Number.isFinite(settings.longitude)) return getStatus();
    if (updating) return getStatus();
    if (!force && cache?.fetchedAt && Date.now() - cache.fetchedAt < CACHE_TTL_MS) {
      return getStatus();
    }

    updating = true;
    const previousContext = buildContext(settings, cache);
    try {
      const parameters = new URLSearchParams({
        latitude: String(settings.latitude),
        longitude: String(settings.longitude),
        current: [
          'temperature_2m',
          'apparent_temperature',
          'precipitation',
          'weather_code',
          'wind_speed_10m'
        ].join(','),
        daily: [
          'temperature_2m_max',
          'temperature_2m_min',
          'precipitation_probability_max'
        ].join(','),
        timezone: settings.timezone || 'auto',
        forecast_days: '1'
      });
      const payload = await fetchJson(`https://api.open-meteo.com/v1/forecast?${parameters}`);
      cache = {
        fetchedAt: Date.now(),
        current: {
          temperature: payload.current?.temperature_2m,
          apparentTemperature: payload.current?.apparent_temperature,
          precipitation: payload.current?.precipitation,
          weatherCode: payload.current?.weather_code,
          windSpeed: payload.current?.wind_speed_10m
        },
        daily: {
          temperatureMax: payload.daily?.temperature_2m_max?.[0],
          temperatureMin: payload.daily?.temperature_2m_min?.[0],
          precipitationProbability: payload.daily?.precipitation_probability_max?.[0]
        }
      };
      writeJson(cachePath, cache);
      retryIndex = 0;
      lastError = '';
      const nextContext = buildContext(settings, cache);
      onUpdate(nextContext, previousContext);
    } catch (error) {
      lastError = error?.message || String(error);
      console.error('Unable to refresh weather:', error);
      scheduleRetry();
    } finally {
      updating = false;
    }
    return getStatus();
  }

  async function setCity(cityName) {
    const city = String(cityName || '').trim();
    if (city.length < 2) throw new Error('请输入至少两个字符的城市名称。');
    const parameters = new URLSearchParams({
      name: city,
      count: '1',
      language: 'zh',
      format: 'json'
    });
    updating = true;
    lastError = '';
    try {
      const domesticLocation = resolveChinaLocation(city);
      if (domesticLocation) {
        settings = {
          enabled: true,
          query: city,
          city: locationLabel(domesticLocation),
          province: domesticLocation.province || '',
          municipality: domesticLocation.city || '',
          district: domesticLocation.district || '',
          precision: domesticLocation.district ? 'district' : domesticLocation.level === '市' ? 'city' : 'province',
          latitude: Number(domesticLocation.latitude),
          longitude: Number(domesticLocation.longitude),
          timezone: 'Asia/Shanghai'
        };
      } else {
        const payload = await fetchJson(
          `https://geocoding-api.open-meteo.com/v1/search?${parameters}`
        );
        const location = payload.results?.[0];
        if (!location) throw new Error(`没有找到地点“${city}”，请填写完整的省、市、区县名称。`);
        settings = {
          enabled: true,
          query: city,
          city: [location.name, location.admin1].filter(Boolean).join('，'),
          province: location.admin1 || '',
          municipality: location.admin2 || '',
          district: location.admin3 || '',
          precision: location.admin3 ? 'district' : 'city',
          latitude: Number(location.latitude),
          longitude: Number(location.longitude),
          timezone: location.timezone || 'auto'
        };
      }
      saveSettings();
      cache = null;
    } catch (error) {
      lastError = error?.message || String(error);
      throw error;
    } finally {
      updating = false;
    }
    return refresh(true);
  }

  function disable() {
    settings = { ...settings, enabled: false };
    saveSettings();
    return getStatus();
  }

  function getContext() {
    return buildContext(settings, cache);
  }

  function getStatus() {
    return {
      settings: { ...settings },
      context: getContext(),
      updating,
      lastError
    };
  }

  function start() {
    if (refreshTimer) return;
    refreshTimer = setInterval(() => refresh(false).catch(() => {}), REFRESH_INTERVAL_MS);
    if (settings.enabled) setTimeout(() => refresh(false).catch(() => {}), 5000);
  }

  function stop() {
    if (refreshTimer) clearInterval(refreshTimer);
    if (retryTimer) clearTimeout(retryTimer);
    refreshTimer = null;
    retryTimer = null;
  }

  return {
    start,
    stop,
    refresh,
    setCity,
    disable,
    getContext,
    getStatus,
    paths: { settingsPath, cachePath }
  };
}

module.exports = {
  createWeatherService,
  weatherStateFromCode,
  weatherLabel,
  resolveChinaLocation,
  geometryCenter,
  locationLabel
};
