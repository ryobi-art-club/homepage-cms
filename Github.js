function dispatchGithubWorkflow_() {
  const config = getConfig_();
  const token = getGithubToken_();
  const url = 'https://api.github.com/repos/' + encodeURIComponent(config.GH_OWNER) + '/' + encodeURIComponent(config.GH_REPO) + '/actions/workflows/' + encodeURIComponent(config.GH_WORKFLOW_FILE) + '/dispatches';
  const response = UrlFetchApp.fetch(url, {
    method: 'post',
    muteHttpExceptions: true,
    contentType: 'application/json',
    headers: {
      Authorization: 'Bearer ' + token,
      Accept: 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28'
    },
    payload: JSON.stringify({ ref: config.GH_BRANCH })
  });
  const code = response.getResponseCode();
  if (code < 200 || code >= 300) {
    throw new Error('GitHub Actions の起動に失敗しました: ' + response.getContentText());
  }
  return {
    actionsUrl: 'https://github.com/' + config.GH_OWNER + '/' + config.GH_REPO + '/actions/workflows/' + config.GH_WORKFLOW_FILE
  };
}

function getGithubToken_() {
  const config = getConfig_();
  if (String(config.GH_AUTH_MODE).toUpperCase() === 'PAT') {
    if (!config.GH_FINE_GRAINED_PAT) throw new Error('GH_FINE_GRAINED_PAT が設定されていません。');
    return config.GH_FINE_GRAINED_PAT;
  }
  if (!config.GH_APP_ID || !config.GH_INSTALLATION_ID || !config.GH_PRIVATE_KEY) {
    throw new Error('GitHub App 用の Script Properties が不足しています。');
  }
  const jwt = createGithubAppJwt_(config.GH_APP_ID, config.GH_PRIVATE_KEY);
  const response = UrlFetchApp.fetch('https://api.github.com/app/installations/' + encodeURIComponent(config.GH_INSTALLATION_ID) + '/access_tokens', {
    method: 'post',
    muteHttpExceptions: true,
    contentType: 'application/json',
    headers: {
      Authorization: 'Bearer ' + jwt,
      Accept: 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28'
    },
    payload: JSON.stringify({})
  });
  const code = response.getResponseCode();
  if (code < 200 || code >= 300) {
    throw new Error('GitHub App の installation token 取得に失敗しました: ' + response.getContentText());
  }
  const data = JSON.parse(response.getContentText());
  return data.token;
}

function createGithubAppJwt_(appId, privateKey) {
  const nowSeconds = Math.floor(Date.now() / 1000);
  const header = {
    alg: 'RS256',
    typ: 'JWT'
  };
  const payload = {
    iat: nowSeconds - 60,
    exp: nowSeconds + (9 * 60),
    iss: appId
  };
  const encodedHeader = base64UrlEncodeString_(JSON.stringify(header));
  const encodedPayload = base64UrlEncodeString_(JSON.stringify(payload));
  const unsigned = encodedHeader + '.' + encodedPayload;
  const signatureBytes = Utilities.computeRsaSha256Signature(unsigned, privateKey);
  return unsigned + '.' + base64UrlEncodeBytes_(signatureBytes);
}

function base64UrlEncodeString_(value) {
  return Utilities.base64EncodeWebSafe(value, Utilities.Charset.UTF_8).replace(/=+$/, '');
}

function base64UrlEncodeBytes_(bytes) {
  return Utilities.base64EncodeWebSafe(bytes).replace(/=+$/, '');
}
