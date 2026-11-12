/**
 * The login page served on loopback during `n8nctl login`.
 *
 * Self-contained on purpose: no CDN scripts, no fonts, no external calls. A
 * page that collects a credential must not also load third-party code. Keep it
 * that way — `tests/login.test.ts` asserts there is no external <script src>.
 *
 * Replace the copy with whatever your service actually requires. The nonce
 * plumbing is the part that must survive editing.
 */
export function loginPage(opts: { nonce: string; baseUrl?: string | null }): string {
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Connect n8nctl</title>
<style>
  * { box-sizing: border-box; margin: 0; padding: 0; }
  body { font-family: system-ui, -apple-system, "Segoe UI", sans-serif; background: #0f172a; color: #e2e8f0; min-height: 100vh; display: flex; align-items: center; justify-content: center; padding: 24px; line-height: 1.5; }
  .card { background: #1e293b; border-radius: 16px; padding: 40px; max-width: 560px; width: 100%; }
  h1 { font-size: 24px; margin-bottom: 6px; }
  .sub { color: #94a3b8; font-size: 15px; margin-bottom: 28px; }
  label { display: block; font-size: 12px; color: #94a3b8; text-transform: uppercase; letter-spacing: 0.05em; margin-bottom: 6px; }
  input { width: 100%; background: #0f172a; border: 1px solid #334155; border-radius: 8px; color: #e2e8f0; padding: 12px; font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 13px; }
  input:focus { outline: none; border-color: #3b82f6; }
  .field { margin-bottom: 18px; }
  button { width: 100%; background: #3b82f6; color: white; border: none; padding: 13px; border-radius: 8px; font-size: 15px; font-weight: 600; cursor: pointer; }
  button:hover { background: #2563eb; }
  button:disabled { opacity: 0.6; cursor: wait; }
  #status { margin-top: 20px; padding: 14px; border-radius: 8px; font-size: 14px; }
  .progress { background: #1e3a5f; color: #93c5fd; }
  .success { background: #064e3b; color: #6ee7b7; }
  .error { background: #7f1d1d; color: #fca5a5; }
</style>
</head>
<body>
<div class="card" id="card">
  <h1>Connect n8nctl</h1>
  <p class="sub">In n8n, open Settings &gt; n8n API and create an API key. The key goes straight to the CLI on this machine and into your OS keychain, and n8nctl sends it only to the n8n address below.</p>

  <form id="form">
    <div class="field">
      <label for="address">n8n address</label>
      <input id="address" name="address" type="url" autocomplete="url" spellcheck="false" placeholder="https://n8n.example.com" value="${escapeAttr(opts.baseUrl ?? "")}">
    </div>
    <div class="field">
      <label for="credential">API key</label>
      <input id="credential" name="credential" type="password" autocomplete="off" spellcheck="false" placeholder="Paste it here" autofocus>
    </div>
    <button id="submit" type="submit">Connect</button>
  </form>

  <div id="status"></div>
</div>

<script>
  var NONCE = ${JSON.stringify(opts.nonce)};
  var form = document.getElementById('form');
  var status = document.getElementById('status');
  var submit = document.getElementById('submit');

  form.addEventListener('submit', function (event) {
    event.preventDefault();
    var credential = document.getElementById('credential').value.trim();
    var address = document.getElementById('address').value.trim();
    if (!address || !credential) {
      status.className = 'error';
      status.textContent = 'Fill in the n8n address and the API key.';
      return;
    }

    submit.disabled = true;
    status.className = 'progress';
    status.textContent = 'Checking...';

    fetch('/callback', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ credential: credential, hint: address, nonce: NONCE })
    })
      .then(function (res) { return res.json().then(function (b) { return { ok: res.ok, body: b }; }); })
      .then(function (result) {
        if (result.ok) {
          document.getElementById('card').innerHTML =
            '<h1>Connected</h1><div class="success">You can close this tab and return to your terminal.</div>';
          return;
        }
        throw new Error(result.body.error || 'The CLI rejected that credential.');
      })
      .catch(function (err) {
        status.className = 'error';
        status.textContent = err.message + ' Nothing was saved.';
        submit.disabled = false;
      });
  });
</script>
</body>
</html>`;
}

function escapeAttr(value: string): string {
  return value.replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}
