const express = require("express");
const Database = require("better-sqlite3");
const crypto = require("crypto");

const app = express();
app.use(express.json());

// =====================================================
// DATABASE
// =====================================================

const db = new Database("licenses.db");

db.prepare(`
    CREATE TABLE IF NOT EXISTS licenses (
        license_key TEXT PRIMARY KEY,
        discord_id TEXT,
        discord_username TEXT,
        hwid TEXT,
        active INTEGER DEFAULT 1,
        created_at INTEGER,
        expires_at INTEGER
    )
`).run();

// =====================================================
// DATABASE MIGRATION
// Maakt ook een oudere licenses.db compatibel
// =====================================================

function getColumns() {
    return db
        .prepare("PRAGMA table_info(licenses)")
        .all()
        .map(column => column.name);
}

function addColumnIfMissing(name, type) {
    const columns = getColumns();

    if (!columns.includes(name)) {
        db.prepare(
            `ALTER TABLE licenses ADD COLUMN ${name} ${type}`
        ).run();

        console.log(`[DB] Added column: ${name}`);
    }
}

addColumnIfMissing("discord_id", "TEXT");
addColumnIfMissing("discord_username", "TEXT");
addColumnIfMissing("created_at", "INTEGER");
addColumnIfMissing("expires_at", "INTEGER");

// =====================================================
// ADMIN SECURITY
// =====================================================

function requireAdmin(req, res, next) {
    const secret = req.headers["x-admin-secret"];

    if (!process.env.LICENSE_ADMIN_SECRET) {
        console.error(
            "[SECURITY] LICENSE_ADMIN_SECRET is not configured!"
        );

        return res.status(500).json({
            success: false,
            error: "server_secret_not_configured"
        });
    }

    if (secret !== process.env.LICENSE_ADMIN_SECRET) {
        return res.status(403).json({
            success: false,
            error: "unauthorized"
        });
    }

    next();
}

// =====================================================
// HELPERS
// =====================================================

function generateLicense() {
    function part() {
        return crypto
            .randomBytes(2)
            .toString("hex")
            .toUpperCase();
    }

    return `DF-${part()}-${part()}-${part()}`;
}

function isExpired(row) {
    if (!row.expires_at) {
        return false;
    }

    return Date.now() >= Number(row.expires_at);
}

function getLicenseStatus(row) {
    if (!row) {
        return "not_found";
    }

    if (row.active !== 1) {
        return "disabled";
    }

    if (isExpired(row)) {
        return "expired";
    }

    if (row.hwid) {
        return "activated";
    }

    return "unused";
}

function getLatestLicenseForDiscord(discordId) {
    return db.prepare(`
        SELECT *
        FROM licenses
        WHERE discord_id = ?
        ORDER BY
            CASE
                WHEN created_at IS NULL THEN 0
                ELSE created_at
            END DESC,
            rowid DESC
        LIMIT 1
    `).get(String(discordId));
}

// =====================================================
// HOME
// =====================================================

app.get("/", (req, res) => {
    res.json({
        success: true,
        service: "DonutFalse License API",
        status: "online",
        version: "2.0"
    });
});

// =====================================================
// CREATE LICENSE
// Used by Discord bot
// =====================================================

app.post("/create-key", requireAdmin, (req, res) => {
    try {
        const {
            discord_id,
            discord_username
        } = req.body;

        if (!discord_id) {
            return res.status(400).json({
                success: false,
                error: "missing_discord_id"
            });
        }

        const existing =
            getLatestLicenseForDiscord(discord_id);

        // Don't create another usable license for same customer
        if (
            existing &&
            existing.active === 1 &&
            !isExpired(existing)
        ) {
            return res.status(409).json({
                success: false,
                error: "user_already_has_license",
                license: existing.license_key
            });
        }

        let licenseKey;

        do {
            licenseKey = generateLicense();
        } while (
            db.prepare(`
                SELECT license_key
                FROM licenses
                WHERE license_key = ?
            `).get(licenseKey)
        );

        const now = Date.now();

        db.prepare(`
            INSERT INTO licenses (
                license_key,
                discord_id,
                discord_username,
                hwid,
                active,
                created_at,
                expires_at
            )
            VALUES (?, ?, ?, NULL, 1, ?, NULL)
        `).run(
            licenseKey,
            String(discord_id),
            discord_username
                ? String(discord_username)
                : null,
            now
        );

        console.log(
            `[LICENSE] Generated ${licenseKey} for ${discord_username || discord_id}`
        );

        return res.json({
            success: true,
            license: licenseKey,
            discord_id: String(discord_id),
            discord_username:
                discord_username || null,
            status: "unused",
            created_at: now,
            expires_at: null,
            duration: "infinite"
        });

    } catch (error) {
        console.error("[CREATE KEY ERROR]", error);

        return res.status(500).json({
            success: false,
            error: "internal_server_error"
        });
    }
});

// =====================================================
// VERIFY LICENSE
// Used by Minecraft mod
// =====================================================

app.post("/verify", (req, res) => {
    try {
        const {
            license,
            hwid
        } = req.body;

        if (!license || !hwid) {
            return res.json({
                valid: false,
                reason: "missing_data"
            });
        }

        const cleanLicense =
            String(license).trim();

        const cleanHwid =
            String(hwid).trim();

        const row = db.prepare(`
            SELECT *
            FROM licenses
            WHERE license_key = ?
        `).get(cleanLicense);

        if (!row) {
            return res.json({
                valid: false,
                reason: "invalid_license"
            });
        }

        // Disabled
        if (row.active !== 1) {
            return res.json({
                valid: false,
                reason: "disabled"
            });
        }

        // Expired
        if (isExpired(row)) {
            return res.json({
                valid: false,
                reason: "expired",
                expires_at: row.expires_at
            });
        }

        // First activation:
        // bind this license to this PC
        if (!row.hwid) {
            db.prepare(`
                UPDATE licenses
                SET hwid = ?
                WHERE license_key = ?
            `).run(
                cleanHwid,
                cleanLicense
            );

            console.log(
                `[LICENSE] First activation: ${cleanLicense}`
            );

            return res.json({
                valid: true,
                reason: "first_activation",
                expires_at: row.expires_at
            });
        }

        // Same PC
        if (row.hwid === cleanHwid) {
            return res.json({
                valid: true,
                reason: "valid",
                expires_at: row.expires_at
            });
        }

        // Different PC
        return res.json({
            valid: false,
            reason: "hwid_mismatch"
        });

    } catch (error) {
        console.error("[VERIFY ERROR]", error);

        return res.status(500).json({
            valid: false,
            reason: "server_error"
        });
    }
});

// =====================================================
// LICENSE INFO
// GET /license-info?discord_id=...
// =====================================================

app.get("/license-info", requireAdmin, (req, res) => {
    try {
        const discordId =
            req.query.discord_id;

        if (!discordId) {
            return res.status(400).json({
                success: false,
                error: "missing_discord_id"
            });
        }

        const row =
            getLatestLicenseForDiscord(discordId);

        if (!row) {
            return res.json({
                success: true,
                found: false
            });
        }

        return res.json({
            success: true,
            found: true,

            license:
                row.license_key,

            discord_id:
                row.discord_id,

            discord_username:
                row.discord_username,

            hwid:
                row.hwid,

            active:
                row.active === 1,

            status:
                getLicenseStatus(row),

            created_at:
                row.created_at,

            expires_at:
                row.expires_at,

            duration:
                row.expires_at
                    ? "temporary"
                    : "infinite"
        });

    } catch (error) {
        console.error("[LICENSE INFO ERROR]", error);

        return res.status(500).json({
            success: false,
            error: "internal_server_error"
        });
    }
});

// =====================================================
// DISABLE LICENSE
// =====================================================

app.post("/license-disable", requireAdmin, (req, res) => {
    try {
        const {
            discord_id
        } = req.body;

        if (!discord_id) {
            return res.status(400).json({
                success: false,
                error: "missing_discord_id"
            });
        }

        const row =
            getLatestLicenseForDiscord(discord_id);

        if (!row) {
            return res.status(404).json({
                success: false,
                error: "license_not_found"
            });
        }

        db.prepare(`
            UPDATE licenses
            SET active = 0
            WHERE license_key = ?
        `).run(row.license_key);

        console.log(
            `[LICENSE] Disabled ${row.license_key}`
        );

        return res.json({
            success: true,
            license: row.license_key,
            status: "disabled"
        });

    } catch (error) {
        console.error("[DISABLE ERROR]", error);

        return res.status(500).json({
            success: false,
            error: "internal_server_error"
        });
    }
});

// =====================================================
// RESET HWID
// Allows same license to bind to another PC
// =====================================================

app.post("/license-reset", requireAdmin, (req, res) => {
    try {
        const {
            discord_id
        } = req.body;

        if (!discord_id) {
            return res.status(400).json({
                success: false,
                error: "missing_discord_id"
            });
        }

        const row =
            getLatestLicenseForDiscord(discord_id);

        if (!row) {
            return res.status(404).json({
                success: false,
                error: "license_not_found"
            });
        }

        db.prepare(`
            UPDATE licenses
            SET hwid = NULL
            WHERE license_key = ?
        `).run(row.license_key);

        console.log(
            `[LICENSE] HWID reset for ${row.license_key}`
        );

        return res.json({
            success: true,
            license: row.license_key,
            hwid_reset: true
        });

    } catch (error) {
        console.error("[RESET ERROR]", error);

        return res.status(500).json({
            success: false,
            error: "internal_server_error"
        });
    }
});

// =====================================================
// LICENSE TIMER
//
// Supported:
// 7d
// 30d
// 90d
// 365d
// infinite
// permanent
// lifetime
// =====================================================

app.post("/license-timer", requireAdmin, (req, res) => {
    try {
        const {
            discord_id,
            duration
        } = req.body;

        if (!discord_id || !duration) {
            return res.status(400).json({
                success: false,
                error: "missing_data"
            });
        }

        const row =
            getLatestLicenseForDiscord(discord_id);

        if (!row) {
            return res.status(404).json({
                success: false,
                error: "license_not_found"
            });
        }

        const normalized =
            String(duration)
                .trim()
                .toLowerCase();

        // =========================
        // PERMANENT
        // =========================

        if (
            normalized === "infinite" ||
            normalized === "permanent" ||
            normalized === "lifetime"
        ) {
            db.prepare(`
                UPDATE licenses
                SET
                    expires_at = NULL,
                    active = 1
                WHERE license_key = ?
            `).run(row.license_key);

            console.log(
                `[LICENSE] ${row.license_key} -> permanent`
            );

            return res.json({
                success: true,
                license: row.license_key,
                duration: "infinite",
                expires_at: null
            });
        }

        // =========================
        // X DAYS
        // Example: 30d
        // =========================

        const match =
            normalized.match(
                /^([1-9][0-9]{0,3})d$/
            );

        if (!match) {
            return res.status(400).json({
                success: false,
                error: "invalid_duration",
                examples: [
                    "7d",
                    "30d",
                    "90d",
                    "365d",
                    "infinite"
                ]
            });
        }

        const days =
            Number(match[1]);

        const expiresAt =
            Date.now() +
            (
                days *
                24 *
                60 *
                60 *
                1000
            );

        db.prepare(`
            UPDATE licenses
            SET
                expires_at = ?,
                active = 1
            WHERE license_key = ?
        `).run(
            expiresAt,
            row.license_key
        );

        console.log(
            `[LICENSE] ${row.license_key} -> ${days}d`
        );

        return res.json({
            success: true,
            license: row.license_key,
            duration: `${days}d`,
            days: days,
            expires_at: expiresAt
        });

    } catch (error) {
        console.error("[TIMER ERROR]", error);

        return res.status(500).json({
            success: false,
            error: "internal_server_error"
        });
    }
});

// =====================================================
// LICENSE STOCK / STATISTICS
// =====================================================

app.get("/license-stock", requireAdmin, (req, res) => {
    try {
        const rows =
            db.prepare(`
                SELECT *
                FROM licenses
            `).all();

        let unused = 0;
        let activated = 0;
        let disabled = 0;
        let expired = 0;

        for (const row of rows) {
            const status =
                getLicenseStatus(row);

            switch (status) {
                case "unused":
                    unused++;
                    break;

                case "activated":
                    activated++;
                    break;

                case "disabled":
                    disabled++;
                    break;

                case "expired":
                    expired++;
                    break;
            }
        }

        return res.json({
            success: true,
            total: rows.length,
            unused: unused,
            activated: activated,
            disabled: disabled,
            expired: expired
        });

    } catch (error) {
        console.error("[STOCK ERROR]", error);

        return res.status(500).json({
            success: false,
            error: "internal_server_error"
        });
    }
});

// =====================================================
// 404 - JSON instead of ugly HTML
// =====================================================

app.use((req, res) => {
    return res.status(404).json({
        success: false,
        error: "route_not_found",
        method: req.method,
        path: req.path
    });
});

// =====================================================
// SERVER
// =====================================================

const PORT =
    process.env.PORT || 3000;

app.listen(
    PORT,
    "0.0.0.0",
    () => {
        console.log(
            `DonutFalse License API online on port ${PORT}`
        );
    }
);
