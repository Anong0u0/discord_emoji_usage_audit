#!/usr/bin/env node
import dotenv from 'dotenv';
import { REST, RESTEvents } from '@discordjs/rest';
import { access, mkdir, readFile, writeFile } from 'node:fs/promises';
import { constants as fsConstants } from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { parse as parseYaml } from 'yaml';

dotenv.config();

const CLI_VERSION = '1.0.0';
const DEFAULT_CONFIG_FILENAME = 'emoji-audit.yml';

const DEFAULT_CONFIG = {
  guildId: '',
  concurrency: 4,
  maxEmojis: null,
  runtime: {
    apiVersion: '9',
    maxRequestRetries: 6,
    retryBaseMs: 750,
    indexRetryCapMs: 15_000,
    logRateLimits: true,
  },
  filters: {
    animated: null,
    available: null,
    managed: null,
    onlyEmojiNames: [],
    skipEmojiNames: [],
  },
  output: {
    dir: './emoji-usage-output',
  },
  format: {
    excerptLength: 120,
  },
};

const HELP_TEXT = `Discord Emoji Usage Audit

Usage:
  emoji-audit [options]
  node emoji-usage-audit.js [options]

Default config:
  The CLI will try to read ./${DEFAULT_CONFIG_FILENAME} (default path)
  If that default file does not exist, execution continues without error.

Environment:
  DISCORD_BOT_TOKEN          Required bot token

Options:
  --config <path>            Load a specific YAML config file (default: ./${DEFAULT_CONFIG_FILENAME})
  --guild-id <id>            Override guildId from config (default: config value)
  --output-dir <path>        Override output.dir (default: ${DEFAULT_CONFIG.output.dir})
  --concurrency <n>          Override concurrency (default: ${DEFAULT_CONFIG.concurrency})
  --max-emojis <n|null>      Override maxEmojis (default: ${DEFAULT_CONFIG.maxEmojis})
  --only <a,b,c>             Override filters.onlyEmojiNames (default: empty)
  --skip <a,b,c>             Override filters.skipEmojiNames (default: empty)
  --animated <true|false>    Set filters.animated (default: null)
  --available <true|false>   Set filters.available (default: null)
  --managed <true|false>     Set filters.managed (default: null)
  --excerpt-length <n>       Override format.excerptLength (default: ${DEFAULT_CONFIG.format.excerptLength})
  --log-rate-limits <true|false>
                             Set runtime.logRateLimits (default: ${DEFAULT_CONFIG.runtime.logRateLimits})
  Output files are always named report-yymmdd-hhmmss.csv/json.
  --help                     Show this help text
  --version                  Show CLI version
`;

function printHelp() {
  console.log(HELP_TEXT);
}

function printVersion() {
  console.log(CLI_VERSION);
}

function isPlainObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function deepMerge(base, override) {
  if (Array.isArray(override)) {
    return [...override];
  }

  if (!isPlainObject(override)) {
    return override;
  }

  const baseObject = isPlainObject(base) ? base : {};
  const result = { ...baseObject };

  for (const [key, value] of Object.entries(override)) {
    if (Array.isArray(value)) {
      result[key] = [...value];
      continue;
    }

    if (isPlainObject(value)) {
      result[key] = deepMerge(baseObject[key], value);
      continue;
    }

    result[key] = value;
  }

  return result;
}

function setNestedValue(target, pathSegments, value) {
  let current = target;

  for (let index = 0; index < pathSegments.length - 1; index += 1) {
    const segment = pathSegments[index];
    if (!isPlainObject(current[segment])) {
      current[segment] = {};
    }
    current = current[segment];
  }

  current[pathSegments[pathSegments.length - 1]] = value;
}

function parseListFlag(value) {
  if (value.trim() === '') return [];
  return value
    .split(',')
    .map((item) => item.trim())
    .filter(Boolean);
}

function parseIntegerFlag(name, value, { allowNull = false, min = 0 } = {}) {
  if (allowNull && ['null', 'none', 'all'].includes(value.toLowerCase())) {
    return null;
  }

  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed) || String(parsed) !== value.trim()) {
    throw new Error(`Invalid value for ${name}: ${value}`);
  }
  if (parsed < min) {
    throw new Error(`${name} must be >= ${min}`);
  }
  return parsed;
}

function parseBooleanFlag(name, value) {
  if (value === 'true') return true;
  if (value === 'false') return false;
  throw new Error(`Invalid value for ${name}: ${value}. Expected true or false.`);
}

function consumeFlagValue(args, index, flagName) {
  const current = args[index];
  const equalSignIndex = current.indexOf('=');
  if (equalSignIndex >= 0) {
    return {
      value: current.slice(equalSignIndex + 1),
      nextIndex: index,
    };
  }

  const next = args[index + 1];
  if (next === undefined || next.startsWith('--')) {
    throw new Error(`Missing value for ${flagName}`);
  }

  return {
    value: next,
    nextIndex: index + 1,
  };
}

function parseCliArgs(argv) {
  const overrides = {};
  let configPath = null;
  let showHelp = false;
  let showVersion = false;

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];

    if (!arg.startsWith('--')) {
      throw new Error(`Unknown positional argument: ${arg}`);
    }

    switch (arg.split('=')[0]) {
      case '--help':
        showHelp = true;
        break;
      case '--version':
        showVersion = true;
        break;
      case '--config': {
        const consumed = consumeFlagValue(argv, index, '--config');
        configPath = consumed.value;
        index = consumed.nextIndex;
        break;
      }
      case '--guild-id': {
        const consumed = consumeFlagValue(argv, index, '--guild-id');
        setNestedValue(overrides, ['guildId'], consumed.value);
        index = consumed.nextIndex;
        break;
      }
      case '--output-dir': {
        const consumed = consumeFlagValue(argv, index, '--output-dir');
        setNestedValue(overrides, ['output', 'dir'], consumed.value);
        index = consumed.nextIndex;
        break;
      }
      case '--concurrency': {
        const consumed = consumeFlagValue(argv, index, '--concurrency');
        setNestedValue(
          overrides,
          ['concurrency'],
          parseIntegerFlag('--concurrency', consumed.value, { min: 1 }),
        );
        index = consumed.nextIndex;
        break;
      }
      case '--max-emojis': {
        const consumed = consumeFlagValue(argv, index, '--max-emojis');
        setNestedValue(
          overrides,
          ['maxEmojis'],
          parseIntegerFlag('--max-emojis', consumed.value, { allowNull: true, min: 0 }),
        );
        index = consumed.nextIndex;
        break;
      }
      case '--only': {
        const consumed = consumeFlagValue(argv, index, '--only');
        setNestedValue(overrides, ['filters', 'onlyEmojiNames'], parseListFlag(consumed.value));
        index = consumed.nextIndex;
        break;
      }
      case '--skip': {
        const consumed = consumeFlagValue(argv, index, '--skip');
        setNestedValue(overrides, ['filters', 'skipEmojiNames'], parseListFlag(consumed.value));
        index = consumed.nextIndex;
        break;
      }
      case '--animated': {
        const consumed = consumeFlagValue(argv, index, '--animated');
        setNestedValue(overrides, ['filters', 'animated'], parseBooleanFlag('--animated', consumed.value));
        index = consumed.nextIndex;
        break;
      }
      case '--available': {
        const consumed = consumeFlagValue(argv, index, '--available');
        setNestedValue(overrides, ['filters', 'available'], parseBooleanFlag('--available', consumed.value));
        index = consumed.nextIndex;
        break;
      }
      case '--managed': {
        const consumed = consumeFlagValue(argv, index, '--managed');
        setNestedValue(overrides, ['filters', 'managed'], parseBooleanFlag('--managed', consumed.value));
        index = consumed.nextIndex;
        break;
      }
      case '--excerpt-length': {
        const consumed = consumeFlagValue(argv, index, '--excerpt-length');
        setNestedValue(
          overrides,
          ['format', 'excerptLength'],
          parseIntegerFlag('--excerpt-length', consumed.value, { min: 0 }),
        );
        index = consumed.nextIndex;
        break;
      }
      case '--log-rate-limits': {
        const consumed = consumeFlagValue(argv, index, '--log-rate-limits');
        setNestedValue(overrides, ['runtime', 'logRateLimits'], parseBooleanFlag('--log-rate-limits', consumed.value));
        index = consumed.nextIndex;
        break;
      }
      default:
        throw new Error(`Unknown option: ${arg}`);
    }
  }

  return {
    configPath,
    overrides,
    showHelp,
    showVersion,
  };
}

async function pathExists(filePath) {
  try {
    await access(filePath, fsConstants.F_OK);
    return true;
  } catch {
    return false;
  }
}

function resolveConfigPath(cliConfigPath) {
  if (cliConfigPath) {
    return {
      path: path.resolve(process.cwd(), cliConfigPath),
      explicit: true,
      source: '--config',
    };
  }

  return {
    path: path.resolve(process.cwd(), DEFAULT_CONFIG_FILENAME),
    explicit: false,
    source: 'default',
  };
}

async function loadConfigFile(configLocation) {
  const exists = await pathExists(configLocation.path);

  if (!exists) {
    if (configLocation.explicit) {
      throw new Error(`Config file not found: ${configLocation.path}`);
    }
    return {};
  }

  const text = await readFile(configLocation.path, 'utf8');

  let parsed;
  try {
    parsed = parseYaml(text);
  } catch (error) {
    throw new Error(`Failed to parse config file ${configLocation.path}: ${error.message}`);
  }

  if (parsed === null || parsed === undefined) {
    return {};
  }

  if (!isPlainObject(parsed)) {
    throw new Error(`Config file ${configLocation.path} must contain a top-level mapping`);
  }

  return parsed;
}

function normalizeOptionalString(value, fieldName) {
  if (value === null || value === undefined) return '';
  if (typeof value !== 'string') {
    throw new Error(`${fieldName} must be a string`);
  }
  return value.trim();
}

function normalizeString(value, fieldName) {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new Error(`${fieldName} must be a non-empty string`);
  }
  return value.trim();
}

function normalizeBooleanOrNull(value, fieldName) {
  if (value === null) return null;
  if (typeof value !== 'boolean') {
    throw new Error(`${fieldName} must be true, false, or null`);
  }
  return value;
}

function normalizeIntegerOrNull(value, fieldName, { min = 0, allowNull = true } = {}) {
  if (value === null || value === undefined) {
    if (allowNull) return null;
    throw new Error(`${fieldName} is required`);
  }

  if (!Number.isInteger(value) || value < min) {
    throw new Error(`${fieldName} must be an integer >= ${min}`);
  }

  return value;
}

function normalizeInteger(value, fieldName, { min = 0 } = {}) {
  if (!Number.isInteger(value) || value < min) {
    throw new Error(`${fieldName} must be an integer >= ${min}`);
  }
  return value;
}

function normalizeStringArray(value, fieldName) {
  if (value === null) return null;
  if (!Array.isArray(value)) {
    throw new Error(`${fieldName} must be an array of strings or null`);
  }

  return value.map((item, index) => {
    if (typeof item !== 'string') {
      throw new Error(`${fieldName}[${index}] must be a string`);
    }
    return item.trim();
  });
}

function buildRuntimeConfig(mergedConfig, envConfig) {
  return {
    token: normalizeOptionalString(envConfig.token, 'DISCORD_BOT_TOKEN'),
    guildId: normalizeOptionalString(mergedConfig.guildId, 'guildId'),
    apiVersion: normalizeString(mergedConfig.runtime.apiVersion, 'runtime.apiVersion'),
    concurrency: normalizeInteger(mergedConfig.concurrency, 'concurrency', { min: 1 }),
    maxRequestRetries: normalizeInteger(mergedConfig.runtime.maxRequestRetries, 'runtime.maxRequestRetries', { min: 0 }),
    retryBaseMs: normalizeInteger(mergedConfig.runtime.retryBaseMs, 'runtime.retryBaseMs', { min: 0 }),
    indexRetryCapMs: normalizeInteger(mergedConfig.runtime.indexRetryCapMs, 'runtime.indexRetryCapMs', { min: 0 }),
    logRateLimits: normalizeBooleanOrNull(mergedConfig.runtime.logRateLimits, 'runtime.logRateLimits') ?? true,
    maxEmojis: normalizeIntegerOrNull(mergedConfig.maxEmojis, 'maxEmojis', { min: 0, allowNull: true }),
    filterAnimated: normalizeBooleanOrNull(mergedConfig.filters.animated, 'filters.animated'),
    filterAvailable: normalizeBooleanOrNull(mergedConfig.filters.available, 'filters.available'),
    filterManaged: normalizeBooleanOrNull(mergedConfig.filters.managed, 'filters.managed'),
    onlyEmojiNames: normalizeStringArray(mergedConfig.filters.onlyEmojiNames, 'filters.onlyEmojiNames'),
    skipEmojiNames: normalizeStringArray(mergedConfig.filters.skipEmojiNames, 'filters.skipEmojiNames') ?? [],
    outputDir: normalizeString(mergedConfig.output.dir, 'output.dir'),
    excerptLength: normalizeInteger(mergedConfig.format.excerptLength, 'format.excerptLength', { min: 0 }),
  };
}

async function loadRuntimeConfig(argv) {
  const cli = parseCliArgs(argv);

  if (cli.showHelp) {
    printHelp();
    process.exit(0);
  }

  if (cli.showVersion) {
    printVersion();
    process.exit(0);
  }

  const envConfig = {
    token: process.env.DISCORD_BOT_TOKEN ?? '',
  };

  const configLocation = resolveConfigPath(cli.configPath);
  const fileConfig = await loadConfigFile(configLocation);
  const mergedConfig = deepMerge(deepMerge(DEFAULT_CONFIG, fileConfig), cli.overrides);

  return buildRuntimeConfig(mergedConfig, envConfig);
}

function createRestClient(config) {
  const client = new REST({ version: config.apiVersion }).setToken(config.token);

  client.on(RESTEvents.RateLimited, (info) => {
    if (!config.logRateLimits) return;
    console.warn(
      `[rate-limit] scope=${info.scope} global=${info.global} method=${info.method} route=${info.route} retryAfterMs=${info.retryAfter}`,
    );
  });

  return client;
}

function assertConfig(config) {
  if (!config.token) {
    throw new Error('Missing required bot token. Set DISCORD_BOT_TOKEN in the environment.');
  }

  if (!config.guildId) {
    throw new Error(`Missing guildId. Set it in ${DEFAULT_CONFIG_FILENAME} or pass --guild-id.`);
  }
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function now() {
  return new Date();
}

function toDate(value) {
  if (!value) return null;
  const date = value instanceof Date ? value : new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
}

function toIso(value) {
  const date = toDate(value);
  return date ? date.toISOString() : '';
}

function toCsvValue(value) {
  if (value === null || value === undefined) return '';
  const text = String(value);
  if (/[",\n\r]/.test(text)) {
    return `"${text.replace(/"/g, '""')}"`;
  }
  return text;
}

function excerpt(text, maxLength) {
  if (!text) return '';
  const normalized = String(text).replace(/\s+/g, ' ').trim();
  if (normalized.length <= maxLength) return normalized;
  return `${normalized.slice(0, maxLength - 1)}...`;
}

function daysBetween(earlier, later = now()) {
  const a = toDate(earlier);
  const b = toDate(later);
  if (!a || !b) return null;
  return Number(((b.getTime() - a.getTime()) / 86_400_000).toFixed(2));
}

function snowflakeToDate(snowflake) {
  if (!snowflake) return null;
  const discordEpoch = 1_420_070_400_000n;
  const ms = Number((BigInt(String(snowflake)) >> 22n) + discordEpoch);
  return new Date(ms);
}

function buildMessageUrl(guildId, channelId, messageId) {
  if (!guildId || !channelId || !messageId) return '';
  return `https://discord.com/channels/${guildId}/${channelId}/${messageId}`;
}

function buildEmojiSearchKeyword(emoji) {
  const animatedPrefix = emoji.animated ? 'a' : '';
  return `<${animatedPrefix}:${emoji.name}:${emoji.id}>`;
}

function buildLatestSearchRoute(guildId, emoji) {
  const params = new URLSearchParams({
    content: buildEmojiSearchKeyword(emoji),
    sort_by: 'timestamp',
    sort_order: 'desc',
    offset: '0',
  });
  return `/guilds/${guildId}/messages/search?${params.toString()}`;
}

function escapeRegex(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function messageContainsEmoji(message, emoji) {
  if (!message?.content) return false;
  const pattern = new RegExp(`<a?:${escapeRegex(emoji.name)}:${escapeRegex(emoji.id)}>`);
  return pattern.test(String(message.content));
}

function findLatestMatchingMessage(messages, emoji) {
  if (!Array.isArray(messages)) return null;

  for (const bucket of messages) {
    if (!Array.isArray(bucket)) continue;

    for (const message of bucket) {
      if (messageContainsEmoji(message, emoji)) {
        return message;
      }
    }
  }

  return null;
}

function summarizeMessage(message, config) {
  if (!message) {
    return {
      timestamp: '',
      contentExcerpt: '',
      url: '',
    };
  }

  return {
    timestamp: toIso(message.timestamp),
    contentExcerpt: excerpt(message.content ?? '', config.excerptLength),
    url: buildMessageUrl(config.guildId, message.channel_id, message.id),
  };
}

function normalizeDiscordError(error) {
  if (!error || typeof error !== 'object') return null;
  return {
    name: error.name,
    message: error.message,
    status: error.status ?? error.code ?? null,
    method: error.method ?? null,
    url: error.url ?? null,
    rawError: error.rawError ?? null,
  };
}

function filterEmojis(emojis, config) {
  const onlySet = Array.isArray(config.onlyEmojiNames) && config.onlyEmojiNames.length > 0
    ? new Set(config.onlyEmojiNames)
    : null;
  const skipSet = new Set(config.skipEmojiNames ?? []);

  return emojis.filter((emoji) => {
    if (config.filterAnimated !== null && Boolean(emoji.animated) !== config.filterAnimated) return false;
    if (config.filterAvailable !== null && Boolean(emoji.available) !== config.filterAvailable) return false;
    if (config.filterManaged !== null && Boolean(emoji.managed) !== config.filterManaged) return false;
    if (onlySet && !onlySet.has(emoji.name)) return false;
    if (skipSet.has(emoji.name)) return false;
    return true;
  });
}

async function apiGet(rest, config, route) {
  let attempt = 0;

  while (true) {
    try {
      const result = await rest.get(route);

      if (
        result &&
        typeof result === 'object' &&
        'code' in result &&
        Number(result.code) === 110000
      ) {
        const retryAfterSeconds = Number(result.retry_after ?? 0);
        const waitMs = Math.min(
          Math.max(250, Math.ceil(retryAfterSeconds * 1000) + Math.floor(Math.random() * 250)),
          config.indexRetryCapMs,
        );
        console.warn(`[indexing] ${route} not ready yet; retrying in ${waitMs}ms`);
        await sleep(waitMs);
        continue;
      }

      return result;
    } catch (error) {
      const normalized = normalizeDiscordError(error);
      const status = Number(normalized?.status ?? 0);
      const retriable = [500, 502, 503, 504].includes(status)
        || /ECONNRESET|ETIMEDOUT|fetch failed/i.test(String(error?.message ?? ''));

      if (!retriable || attempt >= config.maxRequestRetries) {
        throw error;
      }

      const waitMs = config.retryBaseMs * (2 ** attempt) + Math.floor(Math.random() * 250);
      console.warn(`[retry] ${route} failed with status=${status || 'unknown'}; retrying in ${waitMs}ms`);
      attempt += 1;
      await sleep(waitMs);
    }
  }
}

async function getGuildEmojis(rest, config, guildId) {
  const route = `/guilds/${guildId}/emojis`;
  const result = await apiGet(rest, config, route);
  if (!Array.isArray(result)) {
    throw new Error(`Unexpected emoji response shape from ${route}`);
  }
  return result;
}

function searchEmojiLatest(rest, config, emoji) {
  return apiGet(rest, config, buildLatestSearchRoute(config.guildId, emoji));
}

function numberOrZero(value) {
  const n = Number(value ?? 0);
  return Number.isFinite(n) ? n : 0;
}

async function auditEmoji(rest, config, emoji) {
  const createdAt = snowflakeToDate(emoji.id);
  const latestResponse = await searchEmojiLatest(rest, config, emoji);
  const latestMessage = findLatestMatchingMessage(latestResponse.messages, emoji);
  const totalResults = latestMessage ? numberOrZero(latestResponse.total_results) : 0;
  const latest = summarizeMessage(latestMessage, config);
  const lastUseDate = latest.timestamp || '';
  const emojiAgeDays = daysBetween(createdAt);
  const lastUseAgeDays = daysBetween(lastUseDate);
  const usesPer30dSinceCreation = emojiAgeDays && emojiAgeDays > 0
    ? Number(((totalResults / emojiAgeDays) * 30).toFixed(3))
    : 0;

  return {
    emoji_id: String(emoji.id),
    emoji_name: String(emoji.name),
    emoji_query: buildEmojiSearchKeyword(emoji),
    animated: Boolean(emoji.animated),
    available: Boolean(emoji.available),
    managed: Boolean(emoji.managed),
    emoji_created_at: toIso(createdAt),
    emoji_age_days: emojiAgeDays ?? '',
    last_used_at: lastUseDate,
    days_since_last_use: lastUseAgeDays ?? '',
    total_results: totalResults,
    uses_per_30d_since_creation: usesPer30dSinceCreation,
    latest_message_url: latest.url,
    latest_content_excerpt: latest.contentExcerpt,
  };
}

async function mapConcurrent(items, concurrency, mapper) {
  const results = new Array(items.length);
  let nextIndex = 0;

  async function worker() {
    while (true) {
      const currentIndex = nextIndex;
      nextIndex += 1;
      if (currentIndex >= items.length) return;
      results[currentIndex] = await mapper(items[currentIndex], currentIndex);
    }
  }

  const workerCount = Math.max(1, Math.min(concurrency, items.length));
  await Promise.all(Array.from({ length: workerCount }, () => worker()));
  return results;
}

function sortRows(rows) {
  return [...rows].sort((a, b) => {
    const aDays = a.days_since_last_use === '' ? -1 : Number(a.days_since_last_use);
    const bDays = b.days_since_last_use === '' ? -1 : Number(b.days_since_last_use);
    if (aDays !== bDays) return bDays - aDays;

    if (a.total_results !== b.total_results) return a.total_results - b.total_results;
    return a.emoji_name.localeCompare(b.emoji_name);
  });
}

function limitItems(items, maxItems) {
  if (maxItems === null || maxItems === undefined) return items;
  const limit = Number(maxItems);
  if (!Number.isFinite(limit) || limit < 0) return items;
  return items.slice(0, limit);
}

function pad2(value) {
  return String(value).padStart(2, '0');
}

function buildReportBasename(date = new Date()) {
  const year = String(date.getFullYear()).slice(-2);
  const month = pad2(date.getMonth() + 1);
  const day = pad2(date.getDate());
  const hour = pad2(date.getHours());
  const minute = pad2(date.getMinutes());
  const second = pad2(date.getSeconds());
  return `report-${year}${month}${day}-${hour}${minute}${second}`;
}

async function writeCsv(rows, filePath) {
  const headers = rows.length > 0 ? Object.keys(rows[0]) : [];
  const lines = [headers.join(',')];

  for (const row of rows) {
    lines.push(headers.map((header) => toCsvValue(row[header])).join(','));
  }

  await writeFile(filePath, `${lines.join('\n')}\n`, 'utf8');
}

async function writeJson(rows, filePath) {
  await writeFile(filePath, `${JSON.stringify(rows, null, 2)}\n`, 'utf8');
}

function summarizeRun(rows) {
  const available = rows.filter((row) => row.available).length;
  const unavailable = rows.length - available;
  const animated = rows.filter((row) => row.animated).length;
  const staticEmoji = rows.length - animated;

  console.log('');
  console.log('Summary');
  console.log('-------');
  console.log(`Rows: ${rows.length}`);
  console.log(`Available: ${available}`);
  console.log(`Unavailable: ${unavailable}`);
  console.log(`Animated: ${animated}`);
  console.log(`Static: ${staticEmoji}`);

  console.log('');
  console.log('Top 10 candidates to review first:');
  for (const row of rows.slice(0, 10)) {
    console.log(
      `- ${row.emoji_name} | total=${row.total_results} | lastUsed=${row.last_used_at || 'never'} | available=${row.available} | animated=${row.animated}`,
    );
  }
}

async function main() {
  const config = await loadRuntimeConfig(process.argv.slice(2));
  assertConfig(config);
  const rest = createRestClient(config);

  console.log(`Fetching emojis for guild ${config.guildId}...`);
  const emojis = await getGuildEmojis(rest, config, config.guildId);
  const filteredEmojis = limitItems(filterEmojis(emojis, config), config.maxEmojis);
  console.log(`Fetched ${emojis.length} emoji(s); auditing ${filteredEmojis.length} after filters.`);

  const startedAt = Date.now();
  let completed = 0;
  const rows = await mapConcurrent(filteredEmojis, config.concurrency, async (emoji) => {
    const row = await auditEmoji(rest, config, emoji);
    completed += 1;
    console.log(
      `[${completed}/${filteredEmojis.length}] ${emoji.name} -> total=${row.total_results} lastUsed=${row.last_used_at || 'never'}`,
    );
    return row;
  });

  const sortedRows = sortRows(rows);
  await mkdir(config.outputDir, { recursive: true });
  const reportBasename = buildReportBasename();
  const csvPath = path.join(config.outputDir, `${reportBasename}.csv`);
  const jsonPath = path.join(config.outputDir, `${reportBasename}.json`);

  await writeCsv(sortedRows, csvPath);
  await writeJson(sortedRows, jsonPath);
  summarizeRun(sortedRows);

  console.log('');
  console.log(`CSV written to: ${csvPath}`);
  console.log(`JSON written to: ${jsonPath}`);
  console.log(`Elapsed: ${((Date.now() - startedAt) / 1000).toFixed(1)}s`);
}

main().catch((error) => {
  console.error('Fatal error');
  console.error(error.message ?? error);
  process.exitCode = 1;
});
