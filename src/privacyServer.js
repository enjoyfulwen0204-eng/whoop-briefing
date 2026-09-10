#!/usr/bin/env node

import http from 'node:http';

export const PRIVACY_CONTACT = 'enjoyfulwen@hotmail.com';

export const PRIVACY_POLICY_HTML = `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <meta name="color-scheme" content="light dark">
  <title>Kelvin Health OS Privacy Policy</title>
  <style>
    :root { color-scheme: light dark; font-family: system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; line-height: 1.6; }
    body { margin: 0; background: Canvas; color: CanvasText; }
    main { width: min(46rem, calc(100% - 2rem)); margin: 0 auto; padding: 2.5rem 0 4rem; }
    h1 { line-height: 1.15; margin-bottom: .25rem; }
    h2 { line-height: 1.25; margin-top: 2rem; }
    .updated { color: GrayText; margin-top: 0; }
    a { color: LinkText; overflow-wrap: anywhere; }
  </style>
</head>
<body>
<main>
  <h1>Kelvin Health OS Privacy Policy</h1>
  <p class="updated">Effective: September 11, 2026</p>

  <p>Kelvin Health OS is a private wellness information application for a small number of explicitly authorized users. It is not a medical service, does not provide medical diagnoses, and is not endorsed by WHOOP.</p>

  <h2>Information we process</h2>
  <p><strong>WHOOP account and authorization data.</strong> With your authorization, the application receives a WHOOP user identifier and OAuth access and refresh tokens. The application uses the basic profile endpoint only to verify account identity; it does not intentionally store profile names or email addresses returned by WHOOP.</p>
  <p><strong>WHOOP wellness and activity data.</strong> The application retrieves and stores recovery, cycle, sleep, workout, and body-measurement records. Depending on availability, these records may include timestamps, recovery and strain scores, heart-rate variability, resting, average, and maximum heart rate, respiratory rate, blood oxygen, skin temperature, sleep stages and duration, sleep performance, consistency and efficiency, sleep need and debt, disturbances, workout type, heart-rate-zone durations, energy, distance, altitude, height, and weight. Original WHOOP API records may also be retained to support reliable synchronization and later correction.</p>
  <p><strong>Telegram and user-provided information.</strong> The application processes authorized Telegram account and chat identifiers, messages and commands sent to the bot, Journal entries, clarification answers, experiment descriptions, and related conversation state.</p>
  <p><strong>Application-derived information.</strong> The application may calculate and store personal baselines, daily metrics, trends, deviations and z-scores, correlations, insights, experiments, reports, proactive events, model evaluations and predictions, and Healthspan-related estimates. These Healthspan-related outputs are application-derived estimates and are not WHOOP Age, official WHOOP Healthspan results, or reproductions of WHOOP proprietary algorithms.</p>
  <p><strong>Operational information.</strong> The application stores delivery and synchronization state, authorization status, capability checks, error and system-health records, and AI request usage metadata such as model, purpose, token counts, latency, status, and estimated cost. It does not intentionally store AI prompts or model responses in its AI usage ledger.</p>

  <h2>How we use information</h2>
  <p>Information is used to connect and verify authorized accounts, synchronize WHOOP data, create deterministic wellness summaries, answer authorized questions, maintain a user-directed Journal, evaluate personal patterns and experiments, operate proactive wellness features, deliver messages, prevent duplicate processing, secure the service, and diagnose operational failures.</p>

  <h2>AI processing</h2>
  <p>Certain Telegram text may be sent through OpenRouter to the configured language-model provider for limited tasks such as interpreting intent, structuring a Journal entry, or interpreting an experiment request. User messages may contain wellness information, so information sent for these tasks may be sensitive. The application records usage metadata but does not intentionally persist complete prompts or model responses in its own AI usage ledger. Published physiological facts and measurements are rendered from validated application data rather than unrestricted model prose.</p>

  <h2>Service providers and disclosures</h2>
  <p>The application uses WHOOP as the authorized data source; Telegram to receive commands and deliver responses and reports; Turso/libSQL for application storage; Render to run the application; and OpenRouter and the selected model provider for the limited AI processing described above. These providers process information as needed to provide their services and under their own terms and privacy practices.</p>
  <p>Personal or health information is not sold, used for targeted advertising, or shared with advertisers. The application contains no advertising, third-party analytics, external tracking scripts, external fonts, or marketing SDKs. Information may otherwise be disclosed when required by law, to protect users or the service, or with the affected user's direction or consent.</p>

  <h2>Storage, credentials, and security</h2>
  <p>Application records and per-user WHOOP OAuth tokens are stored in the configured Turso/libSQL database. Deployment credentials, including WHOOP client credentials, database credentials, the Telegram bot token, and the OpenRouter key, are supplied to the runtime as environment secrets rather than embedded in this page. The application uses scoped user records, private-chat authorization, OAuth state validation, account-identity checks, access controls, and transport encryption provided by HTTPS-capable services. No system can guarantee absolute security.</p>

  <h2>Retention and deletion</h2>
  <p>Most account, WHOOP, Journal, derived, report, and operational records are retained without a fixed automatic expiration while the service is in use, unless they are replaced or pruned as part of normal operation. Some short-lived authorization and processing records expire or are pruned automatically. Telegram may retain messages under Telegram's own policies.</p>
  <p>To request deletion of your application data or stored authorization tokens, email <a href="mailto:${PRIVACY_CONTACT}">${PRIVACY_CONTACT}</a>. Requests will be verified before action is taken. Some limited records may be retained when reasonably necessary for security, legal obligations, or integrity of completed operations.</p>

  <h2>Authorization and revocation</h2>
  <p>You can revoke the application's WHOOP access through the controls provided by WHOOP. You may also ask the operator to revoke your Telegram link or remove stored authorization information. Revocation stops future access but does not by itself delete information already stored by the application; submit a deletion request if you also want retained application data removed.</p>

  <h2>Limitations</h2>
  <p>The application provides personal wellness information and estimates for informational use. It is not intended to diagnose, treat, cure, or prevent disease, and its output should not replace professional medical advice. If you have a health concern, contact an appropriate healthcare professional.</p>

  <h2>Changes to this policy</h2>
  <p>This policy may be updated as the application or its providers change. The effective date above will be updated when material changes are made.</p>

  <h2>Contact</h2>
  <p>Questions, privacy requests, and deletion requests: <a href="mailto:${PRIVACY_CONTACT}">${PRIVACY_CONTACT}</a>.</p>
</main>
</body>
</html>`;

export function handlePrivacyRequest(req, res) {
  const path = new URL(req.url ?? '/', 'http://localhost').pathname;
  if ((req.method === 'GET' || req.method === 'HEAD') && path === '/privacy') {
    const body = req.method === 'HEAD' ? '' : PRIVACY_POLICY_HTML;
    res.writeHead(200, {
      'Content-Type': 'text/html; charset=utf-8',
      'Content-Length': Buffer.byteLength(body),
      'Cache-Control': 'public, max-age=300',
      'Content-Security-Policy': "default-src 'none'; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'",
      'Referrer-Policy': 'no-referrer',
      'X-Content-Type-Options': 'nosniff',
    });
    res.end(body);
    return;
  }
  res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
  res.end('Not found');
}

export function createPrivacyServer() {
  return http.createServer(handlePrivacyRequest);
}

export function startPrivacyServer({ port = Number(process.env.PORT || 3000) } = {}) {
  const server = createPrivacyServer();
  server.listen(port, '0.0.0.0', () => {
    console.log(`Privacy policy server listening on port ${port}`);
  });
  return server;
}

if (import.meta.url === `file://${process.argv[1]}`) startPrivacyServer();
