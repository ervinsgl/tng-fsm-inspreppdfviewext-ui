/**
 * index.js - Backend Server
 *
 * Express.js server for the FSM Mobile Web Container app.
 * Receives the FSM Mobile POST context, stores it per-session,
 * and serves the UI5 frontend.
 *
 * Session fix: each user gets their own context slot keyed by
 * userName + cloudId. Avoids one user's POST overwriting another's.
 * Sessions are cleaned up after 1 hour to prevent unbounded growth.
 *
 * @file index.js
 * @requires express
 */

const express = require('express');
const path = require('path');
const crypto = require('crypto');
const cookieParser = require('cookie-parser');
const FSMService = require('./utils/FSMService');

const app = express();

// ===========================
// AUTH KEY VALIDATION (FAIL LOUD)
// ===========================
const FSM_WEBCONTAINER_AUTH_KEY = process.env.FSM_WEBCONTAINER_AUTH_KEY;
if (!FSM_WEBCONTAINER_AUTH_KEY) {
    console.error('FATAL: FSM_WEBCONTAINER_AUTH_KEY environment variable is not set.');
    console.error('To set it: cf set-env tns-fsm-inspreppdfviewext-ui-dev FSM_WEBCONTAINER_AUTH_KEY \'<value>\' && cf restage tns-fsm-inspreppdfviewext-ui-dev');
    process.exit(1);
}
console.log(`FSM_WEBCONTAINER_AUTH_KEY is set (${FSM_WEBCONTAINER_AUTH_KEY.length} chars)`);

// ===========================
// SESSION & CONTEXT STORAGE
// ===========================

/**
 * Context store: keyed by contextKey ("<userName>_<cloudId>").
 * Holds the FSM context data sent by FSM Mobile in the entry POST.
 * @type {Object<string, Object>}
 */
const contextStore = {};

/**
 * Session store: keyed by random session token (base64url, 32 bytes).
 * Maps token -> { contextKey, expiresAt }.
 * The token is also set as an HttpOnly cookie on the client.
 * @type {Object<string, {contextKey: string, expiresAt: number}>}
 */
const sessionStore = {};

/**
 * Session lifetime — 60 minutes, sliding (refreshed on each authenticated request in S6).
 */
const SESSION_TTL_MS = 60 * 60 * 1000;

/**
 * Cookie attributes for the fsm_session cookie.
 * Used by both initial issuance (handleMobilePost) and TTL refresh (requireSession).
 * Keep these consistent — drift between the two emission points causes hard-to-diagnose bugs.
 */
const SESSION_COOKIE_OPTIONS = {
    httpOnly: true,
    secure: true,
    sameSite: 'lax',
    path: '/',
    maxAge: SESSION_TTL_MS
};

/**
 * Remove expired sessions and orphaned contexts. Runs every 10 minutes.
 * - Session is removed if its expiresAt is in the past.
 * - Context is removed if no session references it.
 */
setInterval(() => {
    const now = Date.now();
    let removedSessions = 0;
    let removedContexts = 0;

    // Sessions: remove expired
    Object.keys(sessionStore).forEach(token => {
        if (sessionStore[token].expiresAt < now) {
            delete sessionStore[token];
            removedSessions++;
        }
    });

    // Contexts: remove orphans (no session references them anymore)
    const referencedContextKeys = new Set(
        Object.values(sessionStore).map(s => s.contextKey)
    );
    Object.keys(contextStore).forEach(key => {
        if (!referencedContextKeys.has(key)) {
            delete contextStore[key];
            removedContexts++;
        }
    });

    if (removedSessions > 0 || removedContexts > 0) {
        console.log(`Session cleanup: removed ${removedSessions} session(s), ${removedContexts} context(s). Active sessions: ${Object.keys(sessionStore).length}`);
    }
}, 10 * 60 * 1000);

// ===========================
// MIDDLEWARE
// ===========================
app.use((req, res, next) => {
    // Required: allows FSM Mobile WebView to embed this app
    res.removeHeader('X-Frame-Options');
    next();
});
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(cookieParser());
app.enable('trust proxy');

// ===========================
// SESSION MIDDLEWARE
// ===========================

/**
 * requireSession — guards protected routes.
 * Reads the fsm_session cookie, looks up the session, validates expiration.
 * On success: attaches req.session and req.context, calls next().
 * On failure: returns 401 with a structured log line.
 */
function requireSession(req, res, next) {
    const sessionToken = req.cookies?.fsm_session;

    if (!sessionToken) {
        console.warn(`AUTH: rejected ${req.method} ${req.originalUrl} — missing-credential | source=none`);
        return res.status(401).json({ message: 'No session. Open from FSM Mobile.' });
    }

    const session = sessionStore[sessionToken];
    if (!session || session.expiresAt < Date.now()) {
        const reason = !session ? 'unknown-token' : 'expired';
        console.warn(`AUTH: rejected ${req.method} ${req.originalUrl} — invalid-or-expired (${reason}) | source=cookie`);
        return res.status(401).json({ message: 'Session not found or expired.' });
    }

    const context = contextStore[session.contextKey];
    if (!context) {
        console.warn(`AUTH: rejected ${req.method} ${req.originalUrl} — context-missing | contextKey=${session.contextKey}`);
        return res.status(401).json({ message: 'Context not found for this session.' });
    }

    // ===========================
    // SLIDING TTL — refresh expiration on every authenticated request
    // ===========================
    session.expiresAt = Date.now() + SESSION_TTL_MS;

    // Refresh browser-side cookie Max-Age so it doesn't expire while server-side is still alive
    res.cookie('fsm_session', sessionToken, SESSION_COOKIE_OPTIONS);

    // Attach to req for downstream handlers
    req.session = session;
    req.context = context;
    next();
}

// ===========================
// WEB CONTAINER ENTRY POINT
// ===========================

/**
 * Validate the FSM Mobile authenticationKey using constant-time comparison.
 * Returns true if the provided key matches FSM_WEBCONTAINER_AUTH_KEY.
 */
function isValidAuthKey(providedKey) {
    if (!providedKey || typeof providedKey !== 'string') {
        return false;
    }
    const provided = Buffer.from(providedKey);
    const expected = Buffer.from(FSM_WEBCONTAINER_AUTH_KEY);

    // Length-mismatch check before timingSafeEqual — it requires equal-length buffers
    if (provided.length !== expected.length) {
        return false;
    }
    return crypto.timingSafeEqual(provided, expected);
}

/**
 * Handle the FSM Mobile entry POST.
 * Validates authenticationKey, stores context if valid, redirects to the app.
 */
function handleMobilePost(req, res) {
    const body = req.body || {};
    const userName = body.userName || 'unknown';
    const cloudId = body.cloudId || 'unknown';

    // ===========================
    // AUTH CHECK
    // ===========================
    if (!isValidAuthKey(body.authenticationKey)) {
        const reason = !body.authenticationKey ? 'missing' : 'mismatch';
        console.warn(`WC-ACCESS-POINT: rejected POST — authenticationKey ${reason} | user: ${userName} | cloudId: ${cloudId}`);
        return res.status(401).json({ message: 'Unauthorized' });
    }

    // ===========================
    // STORE CONTEXT
    // ===========================
    const contextKey = `${userName}_${cloudId}`;
    contextStore[contextKey] = { ...body, _storedAt: Date.now() };
    delete contextStore[contextKey].authenticationKey;  // never persist the secret

    // ===========================
    // ISSUE SESSION
    // ===========================
    const sessionToken = crypto.randomBytes(32).toString('base64url');
    const expiresAt = Date.now() + SESSION_TTL_MS;
    sessionStore[sessionToken] = { contextKey, expiresAt };

    res.cookie('fsm_session', sessionToken, SESSION_COOKIE_OPTIONS);

    console.log(`WC-ACCESS-POINT: context stored, session issued (contextKey=${contextKey}, sessionStoreSize=${Object.keys(sessionStore).length})`);
    
    // Redirect to app root — cookie is now set, no query param needed
    res.redirect('/');
}

/**
 * POST /web-container-access-point
 *
 * FSM Mobile sends a POST here when opening the web container.
 * Configure this URL in FSM Admin > Company > Web Containers.
 *
 * Context body contains:
 * { userName, authToken, cloudAccount, companyName, cloudId,
 *   objectType, language, dataCloudFullQualifiedDomainName }
 */
app.post('/web-container-access-point', (req, res) => {
    handleMobilePost(req, res);
});

// Fallback: some FSM versions POST to root
app.post('/', (req, res) => {
    handleMobilePost(req, res);
});

/**
 * Returns the FSM context tied to the current session.
 * Single shared handler used by both legacy and v1 paths.
 */
function handleContextFetch(req, res) {
    // requireSession has already attached req.context
    const { _storedAt, authenticationKey, ...contextData } = req.context;
    return res.json(contextData);
}

app.get('/api/v1/context', requireSession, handleContextFetch);

// ===========================
// FSM API ENDPOINTS
// ===========================

/**
 * Shared handler — UdoValue lookup for a given cloudId.
 * Used by both legacy and v1 paths.
 */
async function handleUdoValuesFetch(req, res) {
    const cloudId = req.query.cloudId;

    if (!cloudId) {
        return res.status(400).json({ message: 'cloudId query parameter is required.' });
    }

    try {
        const result = await FSMService.getUdoValues(cloudId);
        return res.json(result);
    } catch (error) {
        console.error('UdoValue endpoint error:', error.message);
        return res.status(500).json({ message: 'Failed to fetch UdoValue data.' });
    }
}

app.get('/api/v1/udo-values', requireSession, handleUdoValuesFetch);

/**
 * GET /api/build-report?objectId=<id>&reportTemplate=<id>&language=<lang>
 *
 * Builds a report via FSM Reporting API and returns the PDF binary.
 * - objectId: Checklist instance ID (z_Linker_Checklist_Instance)
 * - reportTemplate: Report template UUID (z_Linker_PreliminaryReportTemplate)
 * - language: Report language (default: 'de')
 */
/**
 * Shared handler — build PDF report via FSM Reporting API.
 * Used by both legacy and v1 paths.
 */
async function handleBuildReport(req, res) {
    const { objectId, reportTemplate, language } = req.query;

    if (!objectId || !reportTemplate) {
        return res.status(400).json({ message: 'objectId and reportTemplate query parameters are required.' });
    }

    try {
        const pdfBuffer = await FSMService.buildReport(objectId, reportTemplate, language || 'de');

        res.set({
            'Content-Type': 'application/pdf',
            'Content-Length': pdfBuffer.length,
            'Content-Disposition': 'inline; filename="report.pdf"'
        });

        return res.send(pdfBuffer);
    } catch (error) {
        console.error('Build report endpoint error:', error.message);
        return res.status(500).json({ message: error.message || 'Failed to build report.' });
    }
}

app.get('/api/v1/build-report', requireSession, handleBuildReport);

// ===========================
// STATIC FILES (UI5 frontend)
// ===========================
app.use(express.static(path.join(__dirname, 'webapp')));

// ===========================
// START SERVER
// ===========================
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
    console.log(`Server running on port ${PORT}`);
    console.log(`Session TTL: ${SESSION_TTL_MS / 60000} minutes (sliding)`);
    console.log(`Cookie: HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=${SESSION_TTL_MS / 1000}`);
    console.log(`API mounted at /api/v1 (strict auth — Mobile flow only)`);
});