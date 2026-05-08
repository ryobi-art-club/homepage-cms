const APP_NAME = '凌美会 管理画面';
const CONTENT_SHEETS = {
  publishControl: 'PublishControl',
  activityArticles: 'ActivityArticles',
  exhibitions: 'Exhibitions',
  exhibitionWorks: 'ExhibitionWorks',
  requestCases: 'RequestCases',
  changeLog: 'ChangeLog',
  publishedState: '_PublishedState',
  drafts: '_Drafts',
  adminLog: '_AdminLog'
};
const ALLOWLIST_SHEET_NAME = 'allowlist';

function getConfig_() {
  const props = PropertiesService.getScriptProperties();
  const required = [
    'CONTENT_SPREADSHEET_ID',
    'ALLOWLIST_SPREADSHEET_ID',
    'ROOT_RECRUIT_FOLDER_ID',
    'ROOT_ACTIVITY_FOLDER_ID',
    'ROOT_EXHIBITION_FOLDER_ID',
    'ROOT_REQUEST_FOLDER_ID',
    'GH_OWNER',
    'GH_REPO',
    'GH_WORKFLOW_FILE',
    'GH_BRANCH',
    'GH_AUTH_MODE'
  ];
  const config = {};
  required.forEach((key) => {
    config[key] = String(props.getProperty(key) || '').trim();
  });
  const missing = required.filter((key) => !config[key]);
  if (missing.length) {
    throw new Error('Script Properties が不足しています: ' + missing.join(', '));
  }

  config.OTP_TTL_MINUTES = parseInt(props.getProperty('OTP_TTL_MINUTES') || '10', 10);
  config.SESSION_TTL_MINUTES = parseInt(props.getProperty('SESSION_TTL_MINUTES') || '30', 10);
  config.SITE_PREVIEW_URL = String(props.getProperty('SITE_PREVIEW_URL') || '').trim();
  config.GH_APP_ID = String(props.getProperty('GH_APP_ID') || '').trim();
  config.GH_INSTALLATION_ID = String(props.getProperty('GH_INSTALLATION_ID') || '').trim();
  config.GH_PRIVATE_KEY = String(props.getProperty('GH_PRIVATE_KEY') || '').replace(/\\n/g, '\n');
  config.GH_FINE_GRAINED_PAT = String(props.getProperty('GH_FINE_GRAINED_PAT') || '').trim();
  return config;
}

function isoNow_() {
  return new Date().toISOString();
}

function normalizeEmail_(value) {
  return String(value || '').trim().toLowerCase();
}

function sha256Hex_(value) {
  const raw = Utilities.computeDigest(Utilities.DigestAlgorithm.SHA_256, value, Utilities.Charset.UTF_8);
  return raw.map((b) => {
    const v = (b + 256) % 256;
    return ('0' + v.toString(16)).slice(-2);
  }).join('');
}

function asJson_(value) {
  return JSON.stringify(value, null, 2);
}

function parseJson_(value, fallback) {
  if (!value) return fallback;
  try {
    return JSON.parse(value);
  } catch (error) {
    return fallback;
  }
}

function requireString_(value, label, maxLength) {
  const normalized = String(value || '').trim();
  if (!normalized) throw new Error(label + ' を入力してください。');
  if (maxLength && normalized.length > maxLength) throw new Error(label + ' が長すぎます。');
  return normalized;
}

function cleanMultiline_(value, maxLength) {
  const normalized = String(value || '').replace(/\r/g, '').trim();
  if (maxLength && normalized.length > maxLength) {
    throw new Error('入力が長すぎます。');
  }
  return normalized;
}

function include(filename) {
  return HtmlService.createHtmlOutputFromFile(filename).getContent();
}
