function doGet() {
  return HtmlService.createTemplateFromFile('Ui')
    .evaluate()
    .setTitle(APP_NAME)
    .addMetaTag('viewport', 'width=device-width, initial-scale=1');
}

function debugGithubAppKey() {
  const props = PropertiesService.getScriptProperties();

  const authMode = String(props.getProperty('GH_AUTH_MODE') || '').trim();
  const appId = String(props.getProperty('GH_APP_ID') || '').trim();
  const installationId = String(props.getProperty('GH_INSTALLATION_ID') || '').trim();
  const raw = String(props.getProperty('GH_PRIVATE_KEY') || '');

  const normalized = raw
    .replace(/^["']|["']$/g, '')
    .replace(/\\r\\n/g, '\n')
    .replace(/\\n/g, '\n')
    .replace(/\r\n/g, '\n')
    .replace(/\r/g, '\n')
    .trim();

  const lines = normalized.split('\n').filter(Boolean);
  const firstLine = lines[0] || '';
  const lastLine = lines[lines.length - 1] || '';
  const body = lines.slice(1, -1).join('');

  console.log('GH_AUTH_MODE: [' + authMode + ']');
  console.log('GH_APP_ID exists: ' + Boolean(appId));
  console.log('GH_INSTALLATION_ID exists: ' + Boolean(installationId));
  console.log('raw length: ' + raw.length);
  console.log('normalized length: ' + normalized.length);
  console.log('line count: ' + lines.length);
  console.log('first line: [' + firstLine + ']');
  console.log('last line: [' + lastLine + ']');
  console.log('starts with BEGIN: ' + normalized.startsWith('-----BEGIN '));
  console.log('ends with END line: ' + /^-----END .+-----$/.test(lastLine));
  console.log('contains literal backslash-n after normalize: ' + normalized.includes('\\n'));
  console.log('body length: ' + body.length);
  console.log('body base64-like: ' + /^[A-Za-z0-9+/=]+$/.test(body));

  try {
    const sig = Utilities.computeRsaSha256Signature('test', normalized);
    console.log('signature OK: ' + sig.length);
  } catch (e) {
    console.log('signature NG: ' + e.name + ' / ' + e.message);
  }
}