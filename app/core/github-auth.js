'use strict';

/**
 * GitHub OAuth Device Flow.
 *
 * A desktop app cannot keep a client secret: the installer is unpackable, so
 * anything inside it is public. Device flow is the flow designed for exactly
 * this case — the only value shipped is the OAuth application's public client
 * id, the user types a short code at github.com, and GitHub returns a token
 * that belongs to that user and lives only in their own settings file.
 */

const GITHUB = 'https://github.com';
const GRANT_TYPE = 'urn:ietf:params:oauth:grant-type:device_code';

// Client ids are not secrets: they identify the application, and GitHub's own
// device flow puts it in a public URL. Override for a different OAuth app.
const CLIENT_ID = process.env.GUIT_GITHUB_CLIENT_ID || 'Ov23liUndFw0NIFTJLxT';

async function postForm(endpoint, values) {
  let response;
  try {
    response = await fetch(`${GITHUB}${endpoint}`, {
      method: 'POST',
      headers: {
        Accept: 'application/json',
        'Content-Type': 'application/x-www-form-urlencoded',
        'User-Agent': 'GUITinstal/1.0 (+desktop app)',
      },
      body: new URLSearchParams(values).toString(),
      signal: AbortSignal.timeout(15000),
    });
  } catch (error) {
    const reason = error.name === 'TimeoutError' || error.name === 'AbortError' ? 'the request timed out' : error.message;
    throw new Error(`Could not reach GitHub: ${reason}.`);
  }

  const text = await response.text();
  let data = {};
  try {
    data = JSON.parse(text);
  } catch {
    /* GitHub answers some failures as form-encoded text, handled below. */
  }

  if (!response.ok) {
    if (response.status === 404) {
      throw new Error('GitHub does not know this application (client id). Check the OAuth app settings.');
    }
    throw new Error(`GitHub answered ${response.status}${data.error_description ? `: ${data.error_description}` : '.'}`);
  }

  return data;
}

/**
 * Asks GitHub for a device code. `scope` stays empty on purpose: the app only
 * reads public repository data today, so signing in buys API budget, not new
 * permissions. Private repositories would need the `repo` scope plus a git
 * credential helper, and that is a separate decision.
 */
async function start(scope = '') {
  const values = { client_id: CLIENT_ID };
  if (scope) values.scope = scope;

  const data = await postForm('/login/device/code', values);
  if (!data.device_code || !data.user_code) {
    throw new Error(`GitHub did not return a device code${data.error_description ? `: ${data.error_description}` : '. Try again in a minute.'}`);
  }

  return {
    deviceCode: data.device_code,
    userCode: data.user_code,
    verificationUri: data.verification_uri || `${GITHUB}/login/device`,
    verificationUriComplete: data.verification_uri_complete || '',
    interval: Math.max(3, Number(data.interval) || 5),
    expiresAt: Date.now() + Math.max(30, Number(data.expires_in) || 900) * 1000,
  };
}

/**
 * One check per call. The caller keeps the rhythm, so closing the screen or
 * losing the window stops the polling without a timer left inside the server.
 */
async function poll(deviceCode) {
  const data = await postForm('/login/oauth/access_token', {
    client_id: CLIENT_ID,
    device_code: deviceCode,
    grant_type: GRANT_TYPE,
  });

  if (data.access_token) {
    return { status: 'connected', accessToken: data.access_token, scope: data.scope || '' };
  }

  switch (data.error) {
    case 'authorization_pending':
      return { status: 'pending' };
    case 'slow_down':
      return { status: 'pending', intervalUp: true };
    case 'expired_token':
      return { status: 'expired' };
    default:
      throw new Error(`GitHub refused the authorization (${data.error || 'unknown error'}).`);
  }
}

module.exports = { CLIENT_ID, poll, start };
