// 設定：スクリプト プロパティとシートの名前

const CONTENT_SHEETS = {
  recruit: 'Recruit',
  activityArticles: 'ActivityArticles',
  exhibitions: 'Exhibitions',
  requestCases: 'RequestCases',
  changeLog: 'ChangeLog',
  publishedState: '_PublishedState',
  drafts: '_Drafts',
  adminLog: '_AdminLog',
  proofreadChecked: '_ProofreadChecked'
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
  const explicitPreviewUrl = String(props.getProperty('SITE_PREVIEW_URL') || '').trim();
  config.SITE_PREVIEW_URL = explicitPreviewUrl || buildDefaultPreviewUrl_(config);
  config.GH_APP_ID = String(props.getProperty('GH_APP_ID') || '').trim();
  config.GH_INSTALLATION_ID = String(props.getProperty('GH_INSTALLATION_ID') || '').trim();
  config.GH_PRIVATE_KEY = String(props.getProperty('GH_PRIVATE_KEY') || '').replace(/\\n/g, '\n');
  config.GH_FINE_GRAINED_PAT = String(props.getProperty('GH_FINE_GRAINED_PAT') || '').trim();
  config.GEMINI_API_KEY = String(props.getProperty('GEMINI_API_KEY') || '').trim();
  config.GEMINI_MODEL = String(props.getProperty('GEMINI_MODEL') || 'gemini-3.1-flash-lite').trim();
  // 'trash' なら片付けの対象を Drive のゴミ箱に入れる。それ以外は _AdminLog に一覧を書くだけ
  config.CLEANUP_MODE = String(props.getProperty('CLEANUP_MODE') || '').trim().toLowerCase();
  return config;
}

function buildDefaultPreviewUrl_(config) {
  const owner = String(config.GH_OWNER || '').trim();
  const repo = String(config.GH_REPO || '').trim();
  if (!owner || !repo) return '';
  return 'https://' + owner + '.github.io/' + repo + '/';
}
