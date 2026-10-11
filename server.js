"use strict";

require("dotenv").config();

const crypto = require("node:crypto");
const fs = require("node:fs");
const http = require("node:http");
const path = require("node:path");
const mysql = require("mysql2/promise");
const { WebSocket, WebSocketServer } = require("ws");
const { hashPassword, verifyPassword, tokenHash, validISODate } = require("./lib/auth");

const root = __dirname;
const port = Number(process.env.PORT || process.env.SERVER_PORT || 8000);
const host = process.env.HOST || (process.env.SERVER_PORT ? "0.0.0.0" : "127.0.0.1");
const sessionDurationMs = 8 * 60 * 60 * 1000;
const sessionCookie = "votion_session";
const publicFiles = new Set(["index.html", "styles.css", "app.js"]);
const callModes = new Set(["audio", "video"]);
const maxGroupCallParticipants = 8;
const defaultIceServers = [{ urls: "stun:stun.l.google.com:19302" }];
const mimeTypes = {
  ".css": "text/css; charset=utf-8",
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
};

function configuredIceServers() {
  const value = process.env.WEBRTC_ICE_SERVERS;
  if (!value) return defaultIceServers;
  let iceServers;
  try {
    iceServers = JSON.parse(value);
  } catch {
    throw new Error("WEBRTC_ICE_SERVERS must contain a JSON array of ICE server objects.");
  }
  if (!Array.isArray(iceServers) || iceServers.length > 8) {
    throw new Error("WEBRTC_ICE_SERVERS must be an array with no more than eight server entries.");
  }
  for (const server of iceServers) {
    const urls = typeof server?.urls === "string" ? [server.urls] : server?.urls;
    if (!Array.isArray(urls) || !urls.length || urls.some((url) =>
      typeof url !== "string" || !/^(stun|stuns|turn|turns):/i.test(url),
    )) {
      throw new Error("Every WEBRTC_ICE_SERVERS entry must use a valid stun:, stuns:, turn:, or turns: URL.");
    }
    if (urls.some((url) => /^turns?:/i.test(url)) &&
      (typeof server.username !== "string" || !server.username ||
       typeof server.credential !== "string" || !server.credential)) {
      throw new Error("TURN servers in WEBRTC_ICE_SERVERS must include a username and credential.");
    }
  }
  return iceServers;
}

const rtcIceServers = configuredIceServers();

class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

function respondJSON(response, status, payload) {
  response.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
  });
  response.end(JSON.stringify(payload));
}

function databaseOptions() {
  if (process.env.DATABASE_URL) {
    const url = new URL(process.env.DATABASE_URL);
    if (!["mysql:", "mysql2:"].includes(url.protocol)) throw new Error("DATABASE_URL must use the mysql:// scheme.");
    return {
      host: url.hostname,
      port: Number(url.port || 3306),
      user: decodeURIComponent(url.username),
      password: decodeURIComponent(url.password),
      database: decodeURIComponent(url.pathname.slice(1)),
      waitForConnections: true,
      connectionLimit: Number(process.env.DB_POOL_SIZE || 10),
      queueLimit: 0,
      enableKeepAlive: true,
      timezone: "Z",
      dateStrings: true,
      ssl: process.env.DB_TLS === "true" ? { minVersion: "TLSv1.2" } : undefined,
    };
  }
  if (!process.env.DB_HOST || !process.env.DB_USER || !process.env.DB_NAME) {
    throw new Error("Set DATABASE_URL or DB_HOST, DB_USER, DB_NAME, and DB_PASSWORD before starting the server.");
  }
  return {
    host: process.env.DB_HOST,
    port: Number(process.env.DB_PORT || 3306),
    user: process.env.DB_USER,
    password: process.env.DB_PASSWORD || "",
    database: process.env.DB_NAME,
    waitForConnections: true,
    connectionLimit: Number(process.env.DB_POOL_SIZE || 10),
    queueLimit: 0,
    enableKeepAlive: true,
    timezone: "Z",
    dateStrings: true,
    ssl: process.env.DB_TLS === "true" ? { minVersion: "TLSv1.2" } : undefined,
  };
}

const pool = mysql.createPool(databaseOptions());

function normalizeEmail(email) {
  return String(email || "").trim().toLowerCase();
}

function cleanText(value, field, maximum, required = false) {
  const text = String(value ?? "").trim();
  if (required && !text) throw new HttpError(400, `${field} is required.`);
  if (text.length > maximum) throw new HttpError(400, `${field} must be ${maximum} characters or fewer.`);
  return text;
}

function parseCookie(request, name) {
  const cookies = request.headers.cookie || "";
  for (const part of cookies.split(";")) {
    const separator = part.indexOf("=");
    if (separator < 0) continue;
    if (part.slice(0, separator).trim() === name) {
      try {
        return decodeURIComponent(part.slice(separator + 1).trim());
      } catch {
        return "";
      }
    }
  }
  return "";
}

function setSessionCookie(response, token, maxAgeSeconds) {
  const secure = process.env.NODE_ENV === "production" ? "; Secure" : "";
  response.setHeader("Set-Cookie", `${sessionCookie}=${encodeURIComponent(token)}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${maxAgeSeconds}${secure}`);
}

function clearSessionCookie(response) {
  const secure = process.env.NODE_ENV === "production" ? "; Secure" : "";
  response.setHeader("Set-Cookie", `${sessionCookie}=; Path=/; HttpOnly; SameSite=Strict; Max-Age=0${secure}`);
}

function requestOrigin(request) {
  const configuredOrigin = process.env.APP_ORIGIN;
  if (configuredOrigin) {
    try {
      const url = new URL(configuredOrigin);
      if (!["http:", "https:"].includes(url.protocol) || url.origin !== configuredOrigin.replace(/\/$/, "")) {
        throw new Error();
      }
      return url.origin;
    } catch {
      throw new Error("APP_ORIGIN must be an absolute origin such as https://hub.example.com.");
    }
  }
  const scheme = request.socket.encrypted ? "https" : "http";
  return `${scheme}://${request.headers.host || "localhost"}`;
}

function requireSameOrigin(request) {
  const origin = request.headers.origin;
  if (!origin || origin !== requestOrigin(request)) throw new HttpError(403, "Request origin could not be verified.");
}

async function readJSON(request) {
  let body = "";
  for await (const chunk of request) {
    body += chunk;
    if (body.length > 1024 * 1024) throw new HttpError(413, "Request body is too large.");
  }
  if (!body) return {};
  try {
    const data = JSON.parse(body);
    if (!data || Array.isArray(data) || typeof data !== "object") throw new Error();
    return data;
  } catch {
    throw new HttpError(400, "Request body must be a JSON object.");
  }
}

async function migrate() {
  const statements = [
    `CREATE TABLE IF NOT EXISTS users (
      id CHAR(36) PRIMARY KEY,
      email VARCHAR(254) NOT NULL UNIQUE,
      password_hash CHAR(161) NOT NULL,
      name VARCHAR(120) NOT NULL,
      role ENUM('admin', 'employee') NOT NULL DEFAULT 'employee',
      department VARCHAR(120) NOT NULL DEFAULT '',
      job_title VARCHAR(120) NOT NULL DEFAULT '',
      phone VARCHAR(40) NOT NULL DEFAULT '',
      location VARCHAR(120) NOT NULL DEFAULT '',
      manager VARCHAR(120) NOT NULL DEFAULT '',
      created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci`,
    `CREATE TABLE IF NOT EXISTS invitations (
      id CHAR(36) PRIMARY KEY,
      email VARCHAR(254) NOT NULL,
      token_hash CHAR(64) NOT NULL UNIQUE,
      invited_by CHAR(36) NOT NULL,
      expires_at DATETIME NOT NULL,
      accepted_at DATETIME NULL,
      created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
      INDEX invitations_email_idx (email),
      CONSTRAINT invitations_invited_by_fk FOREIGN KEY (invited_by) REFERENCES users(id)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci`,
    `CREATE TABLE IF NOT EXISTS password_resets (
      id CHAR(36) PRIMARY KEY,
      user_id CHAR(36) NOT NULL,
      token_hash CHAR(64) NOT NULL UNIQUE,
      expires_at DATETIME NOT NULL,
      consumed_at DATETIME NULL,
      created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
      INDEX password_resets_expiry_idx (expires_at),
      CONSTRAINT password_reset_user_fk FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci`,
    `CREATE TABLE IF NOT EXISTS sessions (
      token_hash CHAR(64) PRIMARY KEY,
      user_id CHAR(36) NOT NULL,
      expires_at DATETIME NOT NULL,
      created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
      INDEX sessions_expiry_idx (expires_at),
      INDEX sessions_user_idx (user_id),
      CONSTRAINT sessions_user_fk FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci`,
    `CREATE TABLE IF NOT EXISTS auth_attempts (
      bucket_hash CHAR(64) PRIMARY KEY,
      attempt_count INT UNSIGNED NOT NULL,
      reset_at DATETIME NOT NULL,
      INDEX auth_attempt_expiry_idx (reset_at)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci`,
    `CREATE TABLE IF NOT EXISTS work_items (
      id CHAR(36) PRIMARY KEY,
      public_id VARCHAR(24) NOT NULL UNIQUE,
      type ENUM('task', 'ticket') NOT NULL,
      title VARCHAR(180) NOT NULL,
      description TEXT NOT NULL,
      assignee_id CHAR(36) NULL,
      priority ENUM('Low', 'Normal', 'High', 'Critical') NOT NULL DEFAULT 'Normal',
      status ENUM('todo', 'in-progress', 'blocked', 'done') NOT NULL DEFAULT 'todo',
      due_date DATE NULL,
      created_by CHAR(36) NOT NULL,
      created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
      INDEX work_status_idx (status, created_at),
      CONSTRAINT work_assignee_fk FOREIGN KEY (assignee_id) REFERENCES users(id) ON DELETE SET NULL,
      CONSTRAINT work_creator_fk FOREIGN KEY (created_by) REFERENCES users(id)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci`,
    `CREATE TABLE IF NOT EXISTS messages (
      id CHAR(36) PRIMARY KEY,
      channel ENUM('general', 'platform') NOT NULL,
      sender_id CHAR(36) NOT NULL,
      body TEXT NOT NULL,
      created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
      INDEX messages_channel_idx (channel, created_at),
      CONSTRAINT messages_sender_fk FOREIGN KEY (sender_id) REFERENCES users(id) ON DELETE CASCADE
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci`,
    `CREATE TABLE IF NOT EXISTS leave_requests (
      id CHAR(36) PRIMARY KEY,
      user_id CHAR(36) NOT NULL,
      start_date DATE NOT NULL,
      end_date DATE NOT NULL,
      note VARCHAR(1000) NOT NULL DEFAULT '',
      status ENUM('pending', 'approved', 'rejected') NOT NULL DEFAULT 'pending',
      created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
      INDEX leave_user_idx (user_id, created_at),
      CONSTRAINT leave_user_fk FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci`,
    `CREATE TABLE IF NOT EXISTS expenses (
      id CHAR(36) PRIMARY KEY,
      user_id CHAR(36) NOT NULL,
      amount_cents INT UNSIGNED NOT NULL,
      currency CHAR(3) NOT NULL DEFAULT 'USD',
      description VARCHAR(500) NOT NULL,
      status ENUM('pending', 'approved', 'rejected') NOT NULL DEFAULT 'pending',
      created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
      INDEX expenses_user_idx (user_id, created_at),
      CONSTRAINT expenses_user_fk FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci`,
    `CREATE TABLE IF NOT EXISTS attendance (
      id CHAR(36) PRIMARY KEY,
      user_id CHAR(36) NOT NULL,
      work_date DATE NOT NULL,
      checked_in_at DATETIME NOT NULL,
      checked_out_at DATETIME NULL,
      UNIQUE KEY attendance_user_date_uq (user_id, work_date),
      CONSTRAINT attendance_user_fk FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci`,
    `CREATE TABLE IF NOT EXISTS calendar_events (
      id CHAR(36) PRIMARY KEY,
      title VARCHAR(180) NOT NULL,
      starts_at DATETIME NOT NULL,
      location VARCHAR(200) NOT NULL DEFAULT '',
      category VARCHAR(80) NOT NULL DEFAULT 'Company',
      created_by CHAR(36) NOT NULL,
      created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
      INDEX calendar_starts_idx (starts_at),
      CONSTRAINT calendar_creator_fk FOREIGN KEY (created_by) REFERENCES users(id)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci`,
  ];
  for (const statement of statements) await pool.query(statement);

  const [countRows] = await pool.execute("SELECT COUNT(*) AS count FROM users");
  if (Number(countRows[0].count) === 0) {
    const email = normalizeEmail(process.env.INITIAL_ADMIN_EMAIL);
    const name = cleanText(process.env.INITIAL_ADMIN_NAME, "Initial admin name", 120, true);
    const password = process.env.INITIAL_ADMIN_PASSWORD || "";
    if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) throw new Error("Set a valid INITIAL_ADMIN_EMAIL to provision the first account.");
    if (password.length < 12) throw new Error("INITIAL_ADMIN_PASSWORD must contain at least 12 characters.");
    await pool.execute(
      "INSERT INTO users (id, email, password_hash, name, role) VALUES (?, ?, ?, ?, 'admin')",
      [crypto.randomUUID(), email, await hashPassword(password), name],
    );
    console.log(`Provisioned initial administrator: ${email}`);
  }
  await pool.query("DELETE FROM sessions WHERE expires_at < UTC_TIMESTAMP()");
  await pool.query("DELETE FROM invitations WHERE expires_at < UTC_TIMESTAMP() AND accepted_at IS NULL");
  await pool.query("DELETE FROM password_resets WHERE expires_at < UTC_TIMESTAMP() OR consumed_at IS NOT NULL");
  await pool.query("DELETE FROM auth_attempts WHERE reset_at < UTC_TIMESTAMP()");
}

async function currentUser(request) {
  const rawToken = parseCookie(request, sessionCookie);
  if (!rawToken) return null;
  const [rows] = await pool.execute(
    `SELECT u.id, u.email, u.name, u.role, u.department, u.job_title, u.phone, u.location, u.manager
     FROM sessions s JOIN users u ON u.id = s.user_id
     WHERE s.token_hash = ? AND s.expires_at > UTC_TIMESTAMP()`,
    [tokenHash(rawToken)],
  );
  return rows[0] || null;
}

function initialsFor(name) {
  return String(name || "").trim().split(/\s+/).slice(0, 2).map((part) => part[0] || "").join("").toUpperCase();
}

function publicUser(user) {
  return {
    id: user.id,
    name: user.name,
    initials: initialsFor(user.name),
    role: user.job_title || (user.role === "admin" ? "Workspace administrator" : "Employee"),
    jobTitle: user.job_title,
    department: user.department,
    email: user.email,
    phone: user.phone,
    location: user.location,
    manager: user.manager,
    status: "Active",
    accountRole: user.role,
  };
}

async function rows(sql, values = []) {
  const [result] = await pool.execute(sql, values);
  return result;
}

function utcISO(value) {
  const text = String(value);
  return new Date(`${text.replace(" ", "T")}${text.endsWith("Z") ? "" : "Z"}`).toISOString();
}

async function bootstrapData(user) {
  const [people, work, rawMessages, leaveRequests, expenses, attendance, events] = await Promise.all([
    rows("SELECT id, email, name, role, department, job_title, phone, location, manager FROM users ORDER BY name"),
    rows(`SELECT w.id, w.public_id, w.type, w.title, w.description, w.priority, w.status, w.due_date,
                 w.assignee_id, u.name AS assignee
          FROM work_items w LEFT JOIN users u ON u.id = w.assignee_id
          ORDER BY w.created_at DESC`),
    rows(`SELECT m.id, m.channel, m.body, m.created_at, u.name AS sender
          FROM messages m JOIN users u ON u.id = m.sender_id
          ORDER BY m.created_at DESC LIMIT 500`),
    user.role === "admin"
      ? rows("SELECT r.id, r.start_date, r.end_date, r.note, r.status, r.created_at, u.name, u.email FROM leave_requests r JOIN users u ON u.id = r.user_id ORDER BY r.created_at DESC LIMIT 100")
      : rows("SELECT id, start_date, end_date, note, status, created_at, NULL AS name, NULL AS email FROM leave_requests WHERE user_id = ? ORDER BY created_at DESC LIMIT 50", [user.id]),
    user.role === "admin"
      ? rows("SELECT e.id, e.amount_cents, e.currency, e.description, e.status, e.created_at, u.name, u.email FROM expenses e JOIN users u ON u.id = e.user_id ORDER BY e.created_at DESC LIMIT 100")
      : rows("SELECT id, amount_cents, currency, description, status, created_at, NULL AS name, NULL AS email FROM expenses WHERE user_id = ? ORDER BY created_at DESC LIMIT 50", [user.id]),
    rows("SELECT checked_in_at, checked_out_at FROM attendance WHERE user_id = ? AND work_date = UTC_DATE()", [user.id]),
    rows("SELECT id, title, starts_at, location, category FROM calendar_events WHERE starts_at >= DATE_SUB(UTC_TIMESTAMP(), INTERVAL 7 DAY) ORDER BY starts_at LIMIT 100"),
  ]);
  const messages = { general: [], platform: [] };
  for (const message of rawMessages.reverse()) messages[message.channel].push({
    id: message.id,
    sender: message.sender,
    time: utcISO(message.created_at),
    text: message.body,
  });
  const data = {
    user: publicUser(user),
    rtcIceServers,
    people: people.map(publicUser),
    tasks: work.map((item) => ({
      id: item.public_id,
      recordId: item.id,
      assigneeId: item.assignee_id,
      type: item.type,
      title: item.title,
      description: item.description,
      assignee: item.assignee || "Unassigned",
      priority: item.priority,
      status: item.status,
      due: item.due_date ? String(item.due_date).slice(0, 10) : "",
    })),
    messages,
    leaveRequests: leaveRequests.map((request) => ({
      id: request.id,
      start: String(request.start_date).slice(0, 10),
      end: String(request.end_date).slice(0, 10),
      note: request.note,
      status: request.status,
      employee: request.name,
      email: request.email,
    })),
    expenses: expenses.map((expense) => ({
      id: expense.id,
      amountCents: expense.amount_cents,
      currency: expense.currency,
      description: expense.description,
      status: expense.status,
      employee: expense.name,
      email: expense.email,
    })),
    events: events.map((event) => ({
      id: event.id,
      title: event.title,
      startsAt: utcISO(event.starts_at),
      location: event.location,
      category: event.category,
    })),
    attendance: attendance[0] ? {
      checkedIn: !attendance[0].checked_out_at,
      checkedOut: Boolean(attendance[0].checked_out_at),
      checkedInAt: utcISO(attendance[0].checked_in_at),
      checkedOutAt: attendance[0].checked_out_at ? utcISO(attendance[0].checked_out_at) : null,
    } : { checkedIn: false, checkedOut: false },
  };
  if (user.role === "admin") {
    const invites = await rows(
      `SELECT id, email, expires_at, created_at FROM invitations
       WHERE accepted_at IS NULL AND expires_at > UTC_TIMESTAMP() ORDER BY created_at DESC`,
    );
    data.invitations = invites.map((invite) => ({
      id: invite.id,
      email: invite.email,
      expiresAt: utcISO(invite.expires_at),
      createdAt: utcISO(invite.created_at),
    }));
  }
  return data;
}

async function createSession(user, response) {
  const token = crypto.randomBytes(32).toString("base64url");
  const expires = new Date(Date.now() + sessionDurationMs);
  await pool.execute("INSERT INTO sessions (token_hash, user_id, expires_at) VALUES (?, ?, ?)", [
    tokenHash(token), user.id, expires,
  ]);
  setSessionCookie(response, token, Math.floor(sessionDurationMs / 1000));
}

function requireUser(user) {
  if (!user) throw new HttpError(401, "Sign in to continue.");
  return user;
}

function requireAdmin(user) {
  requireUser(user);
  if (user.role !== "admin") throw new HttpError(403, "Workspace administrator access is required.");
}

function loginLimitKeys(request, email) {
  const forwardedFor = process.env.TRUST_PROXY === "true" ? request.headers["x-forwarded-for"] : "";
  const address = forwardedFor ? String(forwardedFor).split(",")[0].trim() : request.socket.remoteAddress || "unknown";
  return [tokenHash(`ip:${address}`), tokenHash(`email:${email}`)];
}

async function checkLoginLimit(keys) {
  for (const key of keys) {
    await pool.execute(
      `INSERT INTO auth_attempts (bucket_hash, attempt_count, reset_at)
       VALUES (?, 1, DATE_ADD(UTC_TIMESTAMP(), INTERVAL 15 MINUTE))
       ON DUPLICATE KEY UPDATE
         attempt_count = IF(reset_at <= UTC_TIMESTAMP(), 1, attempt_count + 1),
         reset_at = IF(reset_at <= UTC_TIMESTAMP(), DATE_ADD(UTC_TIMESTAMP(), INTERVAL 15 MINUTE), reset_at)`,
      [key],
    );
  }
  const result = await rows("SELECT MAX(attempt_count) AS attempts FROM auth_attempts WHERE bucket_hash IN (?, ?)", keys);
  if (Number(result[0].attempts) > 10) throw new HttpError(429, "Too many sign-in attempts. Try again in 15 minutes.");
}

async function clearLoginLimit(keys) {
  await pool.execute("DELETE FROM auth_attempts WHERE bucket_hash IN (?, ?)", keys);
}

function validateEmail(value) {
  const email = normalizeEmail(value);
  if (email.length > 254 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) throw new HttpError(400, "Enter a valid email address.");
  return email;
}

async function handleAPI(request, response, pathname, searchParams) {
  const method = request.method;
  const mutating = !["GET", "HEAD", "OPTIONS"].includes(method);
  if (mutating) requireSameOrigin(request);
  const body = mutating ? await readJSON(request) : {};
  const user = await currentUser(request);

  if (pathname === "/api/health" && method === "GET") {
    await pool.query("SELECT 1");
    return respondJSON(response, 200, { status: "ok" });
  }

  if (pathname === "/api/auth/login" && method === "POST") {
    const email = validateEmail(body.email);
    const password = String(body.password || "");
    if (password.length > 256) throw new HttpError(400, "Password is too long.");
    const limitKeys = loginLimitKeys(request, email);
    await checkLoginLimit(limitKeys);
    const rowsFound = await rows("SELECT id, email, name, role, department, job_title, phone, location, manager, password_hash FROM users WHERE email = ? LIMIT 1", [email]);
    const record = rowsFound[0];
    const storedHash = record?.password_hash || "00000000000000000000000000000000:00000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000";
    if (!await verifyPassword(password, storedHash) || !record) throw new HttpError(401, "Email or password is incorrect.");
    await clearLoginLimit(limitKeys);
    await createSession(record, response);
    return respondJSON(response, 200, { user: publicUser(record) });
  }

  if (pathname === "/api/auth/logout" && method === "POST") {
    const token = parseCookie(request, sessionCookie);
    if (token) await pool.execute("DELETE FROM sessions WHERE token_hash = ?", [tokenHash(token)]);
    clearSessionCookie(response);
    return respondJSON(response, 200, { ok: true });
  }

  if (pathname === "/api/auth/accept-invitation" && method === "POST") {
    const invitationToken = cleanText(body.token, "Invitation token", 128, true);
    const name = cleanText(body.name, "Name", 120, true);
    const password = String(body.password || "");
    if (password.length < 12 || password.length > 256) throw new HttpError(400, "Password must be between 12 and 256 characters.");
    const connection = await pool.getConnection();
    try {
      await connection.beginTransaction();
      const [invites] = await connection.execute(
        "SELECT id, email FROM invitations WHERE token_hash = ? AND accepted_at IS NULL AND expires_at > UTC_TIMESTAMP() FOR UPDATE",
        [tokenHash(invitationToken)],
      );
      const invite = invites[0];
      if (!invite) throw new HttpError(400, "This invitation is invalid, expired, or already used.");
      const id = crypto.randomUUID();
      await connection.execute(
        "INSERT INTO users (id, email, password_hash, name, role) VALUES (?, ?, ?, ?, 'employee')",
        [id, invite.email, await hashPassword(password), name],
      );
      await connection.execute("UPDATE invitations SET accepted_at = UTC_TIMESTAMP() WHERE id = ?", [invite.id]);
      await connection.commit();
      const newUser = { id, email: invite.email, name, role: "employee", department: "", job_title: "", phone: "", location: "", manager: "" };
      const previousToken = parseCookie(request, sessionCookie);
      if (previousToken) await pool.execute("DELETE FROM sessions WHERE token_hash = ?", [tokenHash(previousToken)]);
      await createSession(newUser, response);
      return respondJSON(response, 201, { user: publicUser(newUser) });
    } catch (error) {
      await connection.rollback();
      if (error.code === "ER_DUP_ENTRY") throw new HttpError(409, "An account already exists for this email.");
      throw error;
    } finally {
      connection.release();
    }
  }

  if (pathname === "/api/auth/reset-password" && method === "POST") {
    const resetToken = cleanText(body.token, "Reset token", 128, true);
    const password = String(body.password || "");
    if (password.length < 12 || password.length > 256) throw new HttpError(400, "Password must be between 12 and 256 characters.");
    const connection = await pool.getConnection();
    let resetUser;
    try {
      await connection.beginTransaction();
      const [resetRows] = await connection.execute(
        "SELECT id, user_id FROM password_resets WHERE token_hash = ? AND consumed_at IS NULL AND expires_at > UTC_TIMESTAMP() FOR UPDATE",
        [tokenHash(resetToken)],
      );
      const reset = resetRows[0];
      if (!reset) throw new HttpError(400, "This password link is invalid, expired, or already used.");
      await connection.execute("UPDATE users SET password_hash = ? WHERE id = ?", [await hashPassword(password), reset.user_id]);
      await connection.execute("UPDATE password_resets SET consumed_at = UTC_TIMESTAMP() WHERE id = ?", [reset.id]);
      await connection.execute("DELETE FROM sessions WHERE user_id = ?", [reset.user_id]);
      const [userRows] = await connection.execute(
        "SELECT id, email, name, role, department, job_title, phone, location, manager FROM users WHERE id = ?",
        [reset.user_id],
      );
      resetUser = userRows[0];
      await connection.commit();
    } catch (error) {
      await connection.rollback();
      throw error;
    } finally {
      connection.release();
    }
    await createSession(resetUser, response);
    return respondJSON(response, 200, { user: publicUser(resetUser) });
  }

  if (pathname === "/api/auth/session" && method === "GET") {
    return respondJSON(response, user ? 200 : 401, user ? { user: publicUser(user) } : { error: "Sign in to continue." });
  }

  requireUser(user);

  if (pathname === "/api/bootstrap" && method === "GET") {
    return respondJSON(response, 200, await bootstrapData(user));
  }

  if (pathname === "/api/auth/password" && method === "PUT") {
    const currentPassword = String(body.currentPassword || "");
    const newPassword = String(body.newPassword || "");
    if (currentPassword.length > 256) throw new HttpError(400, "Current password is too long.");
    if (newPassword.length < 12 || newPassword.length > 256) throw new HttpError(400, "New password must be between 12 and 256 characters.");
    const [passwordRows] = await pool.execute("SELECT password_hash FROM users WHERE id = ?", [user.id]);
    if (!await verifyPassword(currentPassword, passwordRows[0]?.password_hash)) throw new HttpError(400, "Current password is incorrect.");
    const currentToken = parseCookie(request, sessionCookie);
    await pool.execute("UPDATE users SET password_hash = ? WHERE id = ?", [await hashPassword(newPassword), user.id]);
    await pool.execute("DELETE FROM sessions WHERE user_id = ? AND token_hash <> ?", [user.id, tokenHash(currentToken)]);
    return respondJSON(response, 200, { ok: true });
  }

  if (pathname === "/api/profile" && method === "PUT") {
    const values = {
      name: cleanText(body.name, "Name", 120, true),
      department: cleanText(body.department, "Department", 120),
      jobTitle: cleanText(body.role, "Job title", 120),
      phone: cleanText(body.phone, "Phone", 40),
      location: cleanText(body.location, "Location", 120),
      manager: cleanText(body.manager, "Manager", 120),
    };
    await pool.execute(
      `UPDATE users SET name = ?, department = ?, job_title = ?, phone = ?, location = ?, manager = ?
       WHERE id = ?`,
      [values.name, values.department, values.jobTitle, values.phone, values.location, values.manager, user.id],
    );
    return respondJSON(response, 200, { user: publicUser({ ...user, ...values, job_title: values.jobTitle }) });
  }

  if (pathname === "/api/work" && method === "POST") {
    const type = body.type === "ticket" ? "ticket" : body.type === "task" ? "task" : null;
    if (!type) throw new HttpError(400, "Work item type must be task or ticket.");
    const title = cleanText(body.title, "Title", 180, true);
    const description = cleanText(body.description, "Description", 5000);
    const priority = ["Low", "Normal", "High", "Critical"].includes(body.priority) ? body.priority : null;
    if (!priority) throw new HttpError(400, "Choose a valid priority.");
    const assigneeId = body.assigneeId ? cleanText(body.assigneeId, "Assignee", 36) : null;
    if (assigneeId && !await rows("SELECT id FROM users WHERE id = ?", [assigneeId]).then((result) => result.length)) {
      throw new HttpError(400, "Choose an active employee as the assignee.");
    }
    const recordId = crypto.randomUUID();
    const publicId = `${type === "ticket" ? "INF" : "T"}-${crypto.randomBytes(3).toString("hex").toUpperCase()}`;
    await pool.execute(
      `INSERT INTO work_items (id, public_id, type, title, description, assignee_id, priority, created_by)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      [recordId, publicId, type, title, description, assigneeId, priority, user.id],
    );
    return respondJSON(response, 201, { id: publicId });
  }

  const workStatus = pathname.match(/^\/api\/work\/([0-9a-f-]{36})$/i);
  if (workStatus && method === "PATCH") {
    if (!["todo", "in-progress", "blocked", "done"].includes(body.status)) throw new HttpError(400, "Choose a valid work status.");
    const result = await pool.execute("UPDATE work_items SET status = ? WHERE id = ?", [body.status, workStatus[1]]);
    if (!result[0].affectedRows) throw new HttpError(404, "Work item not found.");
    return respondJSON(response, 200, { ok: true });
  }

  if (pathname === "/api/messages" && method === "POST") {
    const channel = ["general", "platform"].includes(body.channel) ? body.channel : null;
    if (!channel) throw new HttpError(400, "Choose a valid conversation.");
    const text = cleanText(body.text, "Message", 2000, true);
    const id = crypto.randomUUID();
    await pool.execute("INSERT INTO messages (id, channel, sender_id, body) VALUES (?, ?, ?, ?)", [id, channel, user.id, text]);
    return respondJSON(response, 201, { id });
  }

  if (pathname === "/api/leave-requests" && method === "POST") {
    const start = cleanText(body.start, "Start date", 10, true);
    const end = cleanText(body.end, "End date", 10, true);
    if (!validISODate(start) || !validISODate(end) || end < start) {
      throw new HttpError(400, "Choose valid dates with an end date on or after the start date.");
    }
    const id = crypto.randomUUID();
    await pool.execute(
      "INSERT INTO leave_requests (id, user_id, start_date, end_date, note) VALUES (?, ?, ?, ?, ?)",
      [id, user.id, start, end, cleanText(body.note, "Note", 1000)],
    );
    return respondJSON(response, 201, { id });
  }

  if (pathname === "/api/expenses" && method === "POST") {
    const amount = Number(body.amount);
    if (!Number.isFinite(amount) || amount <= 0 || amount > 10000000) throw new HttpError(400, "Enter an expense amount greater than zero.");
    const currency = cleanText(body.currency || "USD", "Currency", 3, true).toUpperCase();
    if (!/^[A-Z]{3}$/.test(currency)) throw new HttpError(400, "Use a valid three-letter currency code.");
    const id = crypto.randomUUID();
    await pool.execute(
      "INSERT INTO expenses (id, user_id, amount_cents, currency, description) VALUES (?, ?, ?, ?, ?)",
      [id, user.id, Math.round(amount * 100), currency, cleanText(body.description, "Description", 500, true)],
    );
    return respondJSON(response, 201, { id });
  }

  if (pathname === "/api/attendance" && method === "POST") {
    const [rowsFound] = await pool.execute(
      "SELECT id, checked_out_at FROM attendance WHERE user_id = ? AND work_date = UTC_DATE()",
      [user.id],
    );
    if (!rowsFound[0]) {
      await pool.execute(
        "INSERT INTO attendance (id, user_id, work_date, checked_in_at) VALUES (?, ?, UTC_DATE(), UTC_TIMESTAMP())",
        [crypto.randomUUID(), user.id],
      );
      return respondJSON(response, 201, { checkedIn: true });
    }
    if (!rowsFound[0].checked_out_at) {
      await pool.execute("UPDATE attendance SET checked_out_at = UTC_TIMESTAMP() WHERE id = ?", [rowsFound[0].id]);
      return respondJSON(response, 200, { checkedIn: false });
    }
    throw new HttpError(409, "Today’s check-in and check-out are already recorded.");
  }

  const requestDecision = pathname.match(/^\/api\/(leave-requests|expenses)\/([0-9a-f-]{36})$/i);
  if (requestDecision && method === "PATCH") {
    requireAdmin(user);
    if (!["approved", "rejected"].includes(body.status)) throw new HttpError(400, "Choose approved or rejected.");
    const table = requestDecision[1] === "leave-requests" ? "leave_requests" : "expenses";
    const result = await pool.execute(`UPDATE ${table} SET status = ? WHERE id = ?`, [body.status, requestDecision[2]]);
    if (!result[0].affectedRows) throw new HttpError(404, "Request not found.");
    return respondJSON(response, 200, { ok: true });
  }

  if (pathname === "/api/events" && method === "POST") {
    requireAdmin(user);
    const title = cleanText(body.title, "Event title", 180, true);
    const location = cleanText(body.location, "Location", 200);
    const category = cleanText(body.category || "Company", "Category", 80, true);
    const startsAt = new Date(body.startsAt);
    if (!body.startsAt || Number.isNaN(startsAt.getTime())) throw new HttpError(400, "Choose a valid event date and time.");
    const id = crypto.randomUUID();
    await pool.execute(
      "INSERT INTO calendar_events (id, title, starts_at, location, category, created_by) VALUES (?, ?, ?, ?, ?, ?)",
      [id, title, startsAt, location, category, user.id],
    );
    return respondJSON(response, 201, { id });
  }

  if (pathname === "/api/events" && method === "DELETE") {
    requireAdmin(user);
    const id = searchParams.get("id");
    if (!id) throw new HttpError(400, "Event id is required.");
    const result = await pool.execute("DELETE FROM calendar_events WHERE id = ?", [id]);
    if (!result[0].affectedRows) throw new HttpError(404, "Event not found.");
    return respondJSON(response, 200, { ok: true });
  }

  if (pathname === "/api/invitations" && method === "GET") {
    requireAdmin(user);
    return respondJSON(response, 200, { invitations: (await bootstrapData(user)).invitations });
  }

  if (pathname === "/api/password-resets" && method === "POST") {
    requireAdmin(user);
    const userId = cleanText(body.userId, "Employee", 36, true);
    const targets = await rows("SELECT id FROM users WHERE id = ?", [userId]);
    if (!targets.length) throw new HttpError(404, "Employee account not found.");
    const resetToken = crypto.randomBytes(32).toString("base64url");
    const id = crypto.randomUUID();
    await pool.execute("UPDATE password_resets SET consumed_at = UTC_TIMESTAMP() WHERE user_id = ? AND consumed_at IS NULL", [userId]);
    await pool.execute(
      "INSERT INTO password_resets (id, user_id, token_hash, expires_at) VALUES (?, ?, ?, DATE_ADD(UTC_TIMESTAMP(), INTERVAL 1 HOUR))",
      [id, userId, tokenHash(resetToken)],
    );
    const link = new URL("/reset-password", process.env.APP_BASE_URL || requestOrigin(request));
    link.searchParams.set("token", resetToken);
    return respondJSON(response, 201, { id, link: link.toString(), expiresInMinutes: 60 });
  }

  if (pathname === "/api/invitations" && method === "POST") {
    requireAdmin(user);
    const email = validateEmail(body.email);
    const existing = await rows("SELECT id FROM users WHERE email = ?", [email]);
    if (existing.length) throw new HttpError(409, "An account already exists for this email.");
    const inviteToken = crypto.randomBytes(32).toString("base64url");
    const id = crypto.randomUUID();
    await pool.execute(
      `INSERT INTO invitations (id, email, token_hash, invited_by, expires_at)
       VALUES (?, ?, ?, ?, DATE_ADD(UTC_TIMESTAMP(), INTERVAL 7 DAY))`,
      [id, email, tokenHash(inviteToken), user.id],
    );
    const base = process.env.APP_BASE_URL || requestOrigin(request);
    const link = new URL("/invite", base);
    link.searchParams.set("token", inviteToken);
    return respondJSON(response, 201, { id, email, link: link.toString(), expiresInDays: 7 });
  }

  if (pathname === "/api/invitations" && method === "DELETE") {
    requireAdmin(user);
    const id = searchParams.get("id");
    if (!id) throw new HttpError(400, "Invitation id is required.");
    const result = await pool.execute("DELETE FROM invitations WHERE id = ? AND accepted_at IS NULL", [id]);
    if (!result[0].affectedRows) throw new HttpError(404, "Pending invitation not found.");
    return respondJSON(response, 200, { ok: true });
  }

  throw new HttpError(404, "API route not found.");
}

async function handleProxmox(type, response) {
  const baseURL = process.env.PROXMOX_URL;
  const tokenID = process.env.PROXMOX_TOKEN_ID;
  const tokenSecret = process.env.PROXMOX_TOKEN_SECRET;
  if (!baseURL || !tokenID || !tokenSecret) {
    return respondJSON(response, 503, { source: "proxmox", error: "Proxmox is not configured. Set PROXMOX_URL, PROXMOX_TOKEN_ID, and PROXMOX_TOKEN_SECRET." });
  }
  try {
    const parsedURL = new URL(baseURL);
    const loopback = ["localhost", "127.0.0.1", "[::1]"].includes(parsedURL.hostname);
    if (parsedURL.protocol !== "https:" && !(parsedURL.protocol === "http:" && loopback)) {
      throw new HttpError(400, "Proxmox must use HTTPS. HTTP is allowed only for a loopback development endpoint.");
    }
    const endpoint = new URL("/api2/json/cluster/resources", parsedURL);
    endpoint.searchParams.set("type", type);
    const result = await fetch(endpoint, {
      headers: { Authorization: `PVEAPIToken=${tokenID}=${tokenSecret}`, Accept: "application/json" },
      signal: AbortSignal.timeout(8000),
    });
    const payload = await result.json().catch(() => ({}));
    if (!result.ok || !Array.isArray(payload.data)) throw new HttpError(result.status || 502, payload.message || `Proxmox API returned HTTP ${result.status}.`);
    const fields = type === "node"
      ? ["id", "node", "type", "status", "uptime", "cpu", "maxcpu", "mem", "maxmem", "disk", "maxdisk"]
      : ["id", "node", "type", "status", "name", "vmid", "uptime", "cpu", "maxcpu", "mem", "maxmem", "disk", "maxdisk"];
    const resources = payload.data.map((item) => Object.fromEntries(fields.filter((field) => item[field] !== undefined).map((field) => [field, item[field]])));
    respondJSON(response, 200, { source: "proxmox", updatedAt: new Date().toISOString(), resources });
  } catch (error) {
    const status = error.name === "TimeoutError" ? 504 : error.status || 502;
    respondJSON(response, status, { source: "proxmox", error: error.message });
  }
}

function serveFile(response, pathname) {
  let decodedPath;
  try {
    decodedPath = decodeURIComponent(pathname);
  } catch {
    response.writeHead(400);
    response.end("Bad request");
    return;
  }
  if (decodedPath === "/invite" || decodedPath === "/reset-password") decodedPath = "/index.html";
  const relativePath = decodedPath === "/" ? "index.html" : decodedPath.replace(/^\/+/, "");
  if (!publicFiles.has(relativePath)) {
    response.writeHead(404);
    response.end("Not found");
    return;
  }
  const filePath = path.resolve(root, relativePath);
  if (!filePath.startsWith(`${root}${path.sep}`)) {
    response.writeHead(403);
    response.end("Forbidden");
    return;
  }
  fs.readFile(filePath, (error, contents) => {
    if (error) {
      response.writeHead(error.code === "ENOENT" ? 404 : 500);
      response.end(error.code === "ENOENT" ? "Not found" : "Unable to read file");
      return;
    }
    response.writeHead(200, {
      "Content-Type": mimeTypes[path.extname(filePath)] || "application/octet-stream",
      "Cache-Control": "no-store",
    });
    response.end(contents);
  });
}

const server = http.createServer(async (request, response) => {
  response.setHeader("X-Content-Type-Options", "nosniff");
  response.setHeader("Referrer-Policy", "same-origin");
  response.setHeader("X-Frame-Options", "DENY");
  const websocketOrigin = requestOrigin(request).replace(/^http/, "ws");
  response.setHeader("Content-Security-Policy", `default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; font-src 'self' https://fonts.gstatic.com; img-src 'self' data:; connect-src 'self' ${websocketOrigin}; base-uri 'self'; form-action 'self'; frame-ancestors 'none'`);

  let url;
  try {
    url = new URL(request.url, "http://localhost");
    const proxmoxType = url.pathname === "/api/proxmox/nodes" ? "node" : url.pathname === "/api/proxmox/vms" ? "vm" : null;
    if (proxmoxType) {
      const user = await currentUser(request);
      requireUser(user);
      if (request.method !== "GET") throw new HttpError(405, "Only GET requests are supported.");
      return await handleProxmox(proxmoxType, response);
    }
    if (url.pathname.startsWith("/api/")) {
      return await handleAPI(request, response, url.pathname, url.searchParams);
    }
    if (request.method !== "GET" && request.method !== "HEAD") {
      response.writeHead(405);
      return response.end("Method not allowed");
    }
    serveFile(response, url.pathname);
  } catch (error) {
    const status = error instanceof HttpError ? error.status : error.code === "ER_DUP_ENTRY" ? 409 : 500;
    if (status >= 500) console.error("Request failed:", error);
    if (!response.headersSent) respondJSON(response, status, { error: status >= 500 ? "The request could not be completed. Please try again." : error.message });
    else response.destroy();
  }
});

const callWebSocketServer = new WebSocketServer({ noServer: true, maxPayload: 65536, perMessageDeflate: false });
const callClients = new Map();
const callRooms = new Map();

function sendCallEvent(client, event) {
  if (client.socket.readyState === WebSocket.OPEN) client.socket.send(JSON.stringify(event));
}

function callPeer(client) {
  return { id: client.id, userId: client.user.id, name: client.user.name, initials: initialsFor(client.user.name) };
}

function broadcastGroupCallCounts() {
  const counts = { audio: 0, video: 0 };
  for (const room of callRooms.values()) {
    if (room.kind === "group") counts[room.mode] = room.members.size;
  }
  for (const client of callClients.values()) sendCallEvent(client, { type: "group-call-counts", counts });
}

function removeCallRoom(room, message) {
  if (callRooms.get(room.id) !== room) return;
  clearTimeout(room.ringTimer);
  callRooms.delete(room.id);
  for (const member of room.members) {
    member.roomId = null;
    if (message) sendCallEvent(member, message);
  }
  if (room.kind === "direct" && room.status === "ringing") {
    for (const client of callClients.values()) {
      if (client.user.id === room.targetId) {
        sendCallEvent(client, { type: "call-invitation-closed", callId: room.id });
      }
    }
  }
  if (room.kind === "group") broadcastGroupCallCounts();
}

function leaveCallRoom(client, message = { type: "call-ended" }) {
  const room = callRooms.get(client.roomId);
  if (!room) {
    client.roomId = null;
    return;
  }
  if (room.kind === "direct" || room.members.size <= 1) {
    removeCallRoom(room, message);
    return;
  }
  room.members.delete(client);
  client.roomId = null;
  for (const member of room.members) sendCallEvent(member, { type: "room-peer-left", peerId: client.id });
  broadcastGroupCallCounts();
}

function callError(client, message) {
  sendCallEvent(client, { type: "call-error", message });
}

function handleCallMessage(client, data) {
  if (!data || typeof data !== "object" || Array.isArray(data)) {
    callError(client, "Invalid call message.");
    return;
  }
  if (data.type === "start-call") {
    const targetId = typeof data.targetId === "string" ? data.targetId : "";
    if (!callModes.has(data.mode) || !targetId || targetId === client.user.id) {
      callError(client, "Choose a teammate and a valid call type.");
      return;
    }
    if (client.roomId) {
      callError(client, "End your current call before starting another.");
      return;
    }
    const recipients = [...callClients.values()].filter((candidate) =>
      candidate.user.id === targetId && candidate.roomId === null && candidate.socket.readyState === WebSocket.OPEN,
    );
    if (!recipients.length) {
      sendCallEvent(client, { type: "call-unavailable", targetId });
      return;
    }
    client.roomId = "pending";
    pool.execute("SELECT id, name FROM users WHERE id = ? LIMIT 1", [targetId]).then(([users]) => {
      if (client.socket.readyState !== WebSocket.OPEN || client.roomId !== "pending") return;
      if (!users.length) {
        client.roomId = null;
        sendCallEvent(client, { type: "call-unavailable", targetId });
        return;
      }
      const availableRecipients = recipients.filter((recipient) =>
        recipient.roomId === null && recipient.socket.readyState === WebSocket.OPEN,
      );
      if (!availableRecipients.length) {
        client.roomId = null;
        sendCallEvent(client, { type: "call-unavailable", targetId });
        return;
      }
      const room = {
        id: crypto.randomUUID(),
        kind: "direct",
        mode: data.mode,
        status: "ringing",
        initiator: client,
        targetId,
        members: new Set([client]),
      };
      room.ringTimer = setTimeout(() => {
        if (callRooms.get(room.id) !== room || room.status !== "ringing") return;
        sendCallEvent(room.initiator, { type: "call-no-answer", callId: room.id });
        removeCallRoom(room);
      }, 45000);
      room.ringTimer.unref();
      client.roomId = room.id;
      callRooms.set(room.id, room);
      sendCallEvent(client, { type: "call-ringing", roomId: room.id, mode: room.mode, target: { id: targetId, name: users[0].name } });
      for (const recipient of availableRecipients) {
        sendCallEvent(recipient, {
          type: "incoming-call",
          callId: room.id,
          mode: room.mode,
          caller: callPeer(client),
        });
      }
    }).catch((error) => {
      if (client.roomId === "pending") client.roomId = null;
      console.error("Could not start call:", error.message);
      callError(client, "The call could not be started. Please try again.");
    });
    return;
  }

  if (data.type === "join-group-call") {
    if (!callModes.has(data.mode)) {
      callError(client, "Choose a valid group call type.");
      return;
    }
    if (client.roomId) {
      callError(client, "End your current call before joining another.");
      return;
    }
    const roomId = `team-${data.mode}`;
    let room = callRooms.get(roomId);
    if (room && [...room.members].some((member) => member.user.id === client.user.id)) {
      callError(client, "You have already joined this group call in another tab.");
      return;
    }
    if (room && room.members.size >= maxGroupCallParticipants) {
      callError(client, `This group call is full (maximum ${maxGroupCallParticipants} participants).`);
      return;
    }
    if (!room) {
      room = { id: roomId, kind: "group", mode: data.mode, members: new Set() };
      callRooms.set(room.id, room);
    }
    const peers = [...room.members].map(callPeer);
    room.members.add(client);
    client.roomId = room.id;
    sendCallEvent(client, { type: "room-joined", roomId: room.id, mode: room.mode, peers });
    for (const member of room.members) {
      if (member !== client) sendCallEvent(member, { type: "room-peer-joined", peer: callPeer(client) });
    }
    broadcastGroupCallCounts();
    return;
  }

  if (data.type === "accept-call" || data.type === "decline-call") {
    const room = callRooms.get(typeof data.callId === "string" ? data.callId : "");
    if (!room || room.kind !== "direct" || room.status !== "ringing" || room.targetId !== client.user.id) {
      callError(client, "This call invitation has expired.");
      return;
    }
    if (data.type === "decline-call") {
      sendCallEvent(room.initiator, { type: "call-declined", callId: room.id });
      removeCallRoom(room);
      return;
    }
    if (client.roomId) {
      callError(client, "End your current call before accepting another.");
      return;
    }
    room.status = "active";
    clearTimeout(room.ringTimer);
    room.members.add(client);
    client.roomId = room.id;
    sendCallEvent(room.initiator, { type: "call-accepted", roomId: room.id, peer: callPeer(client) });
    sendCallEvent(client, {
      type: "room-joined",
      roomId: room.id,
      mode: room.mode,
      peers: [callPeer(room.initiator)],
    });
    for (const recipient of callClients.values()) {
      if (recipient.user.id === room.targetId && recipient !== client) {
        sendCallEvent(recipient, { type: "call-invitation-closed", callId: room.id });
      }
    }
    return;
  }

  if (data.type === "peer-signal") {
    const room = callRooms.get(client.roomId);
    const peerId = typeof data.peerId === "string" ? data.peerId : "";
    const peer = room && [...room.members].find((member) => member.id === peerId && member !== client);
    if (!peer || !data.signal || typeof data.signal !== "object" || Array.isArray(data.signal)) {
      callError(client, "This participant is no longer in the call.");
      return;
    }
    const signal = data.signal;
    if (signal.description) {
      if (!["offer", "answer"].includes(signal.description.type) || typeof signal.description.sdp !== "string" || signal.description.sdp.length > 60000) {
        callError(client, "Invalid call description.");
        return;
      }
      sendCallEvent(peer, { type: "peer-signal", peer: callPeer(client), signal: { description: signal.description } });
      return;
    }
    if (signal.candidate === null || signal.candidate && typeof signal.candidate === "object" &&
      typeof signal.candidate.candidate === "string" && signal.candidate.candidate.length <= 4096) {
      sendCallEvent(peer, { type: "peer-signal", peer: callPeer(client), signal: { candidate: signal.candidate } });
      return;
    }
    callError(client, "Invalid call signal.");
    return;
  }

  if (data.type === "leave-call") {
    leaveCallRoom(client);
    return;
  }

  callError(client, "Unknown call action.");
}

server.on("upgrade", (request, socket, head) => {
  let url;
  try {
    url = new URL(request.url, "http://localhost");
    if (url.pathname !== "/api/calls") {
      socket.destroy();
      return;
    }
    if (request.headers.origin !== requestOrigin(request)) {
      socket.end("HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n");
      return;
    }
  } catch {
    socket.end("HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n");
    return;
  }
  currentUser(request).then((user) => {
    if (!user) {
      socket.end("HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n");
      return;
    }
    callWebSocketServer.handleUpgrade(request, socket, head, (websocket) => {
      const sessionHash = tokenHash(parseCookie(request, sessionCookie));
      const client = {
        id: crypto.randomUUID(),
        user,
        socket: websocket,
        roomId: null,
        sessionHash,
      };
      callClients.set(websocket, client);
      sendCallEvent(client, { type: "call-server-ready" });
      broadcastGroupCallCounts();
      websocket.on("message", (payload) => {
        let data;
        try {
          data = JSON.parse(payload.toString());
        } catch {
          callError(client, "Call message must be valid JSON.");
          return;
        }
        handleCallMessage(client, data);
      });
      websocket.on("close", () => {
        leaveCallRoom(client);
        callClients.delete(websocket);
      });
      websocket.on("error", (error) => console.error("Call connection failed:", error.message));
    });
  }).catch((error) => {
    console.error("Call connection authentication failed:", error.message);
    if (!socket.destroyed) socket.end("HTTP/1.1 500 Internal Server Error\r\nConnection: close\r\n\r\n");
  });
});

const callMaintenanceTimer = setInterval(async () => {
  const clients = [...callClients.values()];
  if (!clients.length) return;
  try {
    const hashes = [...new Set(clients.map((client) => client.sessionHash))];
    const placeholders = hashes.map(() => "?").join(", ");
    const activeSessions = await rows(
      `SELECT token_hash FROM sessions WHERE expires_at > UTC_TIMESTAMP() AND token_hash IN (${placeholders})`,
      hashes,
    );
    const activeHashes = new Set(activeSessions.map((session) => session.token_hash));
    for (const client of clients) {
      if (!activeHashes.has(client.sessionHash)) client.socket.close(4401, "Session expired");
      else if (client.socket.readyState === WebSocket.OPEN) client.socket.ping();
    }
  } catch (error) {
    console.error("Call session check failed:", error.message);
  }
}, 30000);
callMaintenanceTimer.unref();

async function start() {
  if (process.env.NODE_ENV === "production") {
    if (!process.env.APP_ORIGIN || !process.env.APP_BASE_URL) {
      throw new Error("Production requires APP_ORIGIN and APP_BASE_URL set to the public HTTPS origin.");
    }
    if (!process.env.APP_ORIGIN.startsWith("https://") || !process.env.APP_BASE_URL.startsWith("https://")) {
      throw new Error("APP_ORIGIN and APP_BASE_URL must use HTTPS in production.");
    }
    if (new URL(process.env.APP_ORIGIN).origin !== new URL(process.env.APP_BASE_URL).origin) {
      throw new Error("APP_ORIGIN and APP_BASE_URL must use the same origin.");
    }
  }
  await migrate();
  server.listen(port, host, () => console.log(`VOTION CLOUD is available at http://${host}:${port}`));
  const cleanupTimer = setInterval(() => {
    pool.query("DELETE FROM sessions WHERE expires_at < UTC_TIMESTAMP()").catch((error) => console.error("Session cleanup failed:", error.message));
    pool.query("DELETE FROM auth_attempts WHERE reset_at < UTC_TIMESTAMP()").catch((error) => console.error("Login-attempt cleanup failed:", error.message));
  }, 60 * 60 * 1000);
  cleanupTimer.unref();
}

start().catch((error) => {
  console.error("Server startup failed:", error.message);
  process.exitCode = 1;
});

for (const signal of ["SIGINT", "SIGTERM"]) {
  process.on(signal, async () => {
    clearInterval(callMaintenanceTimer);
    for (const client of callClients.values()) client.socket.close(1001, "Server shutting down");
    callWebSocketServer.close();
    server.close();
    await pool.end();
    process.exit(0);
  });
}
