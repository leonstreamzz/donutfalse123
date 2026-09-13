const express = require("express");
const crypto = require("crypto");
const { Pool } = require("pg");

const app = express();

app.use(express.json());

// =====================================================
// POSTGRES DATABASE
// =====================================================

const pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl:
        process.env.NODE_ENV === "production"
            ? { rejectUnauthorized: false }
            : false
});

// =====================================================
// DATABASE SETUP
// =====================================================

async function setupDatabase() {

    await pool.query(`
        CREATE TABLE IF NOT EXISTS licenses (
            license_key TEXT PRIMARY KEY,

            discord_id TEXT UNIQUE NOT NULL,
            discord_username TEXT,

            hwid TEXT,

            active BOOLEAN NOT NULL DEFAULT TRUE,

            created_at BIGINT NOT NULL,

            expires_at BIGINT,

            hwid_reset_count INTEGER NOT NULL DEFAULT 0,

            last_hwid_reset_at BIGINT
        )
    `);

    console.log("[DATABASE] License table ready.");
}

// =====================================================
// ADMIN SECURITY
// =====================================================

function requireAdmin(req, res, next) {

    const secret =
        req.headers["x-admin-secret"];

    if (!process.env.LICENSE_ADMIN_SECRET) {

        console.error(
            "[SECURITY] LICENSE_ADMIN_SECRET is missing!"
        );

        return res.status(500).json({
            success: false,
            error: "server_secret_not_configured"
        });
    }

    if (
        !secret ||
        secret !== process.env.LICENSE_ADMIN_SECRET
    ) {

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

    if (!row.active) {
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

async function getLicenseByDiscord(discordId) {

    const result =
        await pool.query(
            `
            SELECT *
            FROM licenses
            WHERE discord_id = $1
            LIMIT 1
            `,
            [
                String(discordId)
            ]
        );

    return result.rows[0] || null;
}

async function getLicenseByKey(licenseKey) {

    const result =
        await pool.query(
            `
            SELECT *
            FROM licenses
            WHERE license_key = $1
            LIMIT 1
            `,
            [
                String(licenseKey)
            ]
        );

    return result.rows[0] || null;
}

// =====================================================
// HOME
// =====================================================

app.get("/", (req, res) => {

    res.json({
        success: true,
        service: "DonutFalse License API",
        status: "online",
        database: "postgres",
        version: "3.0"
    });
});

// =====================================================
// CREATE LICENSE
//
// Eén Discord account = één license.
//
// Als de user al een license heeft:
// -> GEEN nieuwe key
// -> bestaande key blijft behouden
// =====================================================

app.post(
    "/create-key",
    requireAdmin,
    async (req, res) => {

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
                await getLicenseByDiscord(
                    discord_id
                );

            // =========================================
            // USER HEEFT AL EEN LICENSE
            // =========================================

            if (existing) {

                // Username eventueel updaten
                if (
                    discord_username &&
                    discord_username !==
                    existing.discord_username
                ) {

                    await pool.query(
                        `
                        UPDATE licenses
                        SET discord_username = $1
                        WHERE discord_id = $2
                        `,
                        [
                            String(discord_username),
                            String(discord_id)
                        ]
                    );
                }

                return res.json({
                    success: true,
                    existing: true,

                    license:
                        existing.license_key,

                    discord_id:
                        existing.discord_id,

                    discord_username:
                        discord_username ||
                        existing.discord_username,

                    active:
                        existing.active,

                    hwid:
                        existing.hwid,

                    status:
                        getLicenseStatus(existing),

                    created_at:
                        Number(existing.created_at),

                    expires_at:
                        existing.expires_at
                            ? Number(existing.expires_at)
                            : null
                });
            }

            // =========================================
            // NIEUWE LICENSE
            // =========================================

            let licenseKey;

            while (true) {

                licenseKey =
                    generateLicense();

                const found =
                    await getLicenseByKey(
                        licenseKey
                    );

                if (!found) {
                    break;
                }
            }

            const now =
                Date.now();

            await pool.query(
                `
                INSERT INTO licenses (
                    license_key,
                    discord_id,
                    discord_username,
                    hwid,
                    active,
                    created_at,
                    expires_at,
                    hwid_reset_count,
                    last_hwid_reset_at
                )
                VALUES (
                    $1,
                    $2,
                    $3,
                    NULL,
                    TRUE,
                    $4,
                    NULL,
                    0,
                    NULL
                )
                `,
                [
                    licenseKey,
                    String(discord_id),
                    discord_username
                        ? String(discord_username)
                        : null,
                    now
                ]
            );

            console.log(
                `[LICENSE] Generated ${licenseKey} for ${discord_username || discord_id}`
            );

            return res.json({
                success: true,
                existing: false,

                license:
                    licenseKey,

                discord_id:
                    String(discord_id),

                discord_username:
                    discord_username || null,

                active:
                    true,

                hwid:
                    null,

                status:
                    "unused",

                created_at:
                    now,

                expires_at:
                    null,

                duration:
                    "infinite"
            });

        } catch (error) {

            console.error(
                "[CREATE KEY ERROR]",
                error
            );

            return res.status(500).json({
                success: false,
                error: "internal_server_error"
            });
        }
    }
);

// =====================================================
// VERIFY LICENSE
//
// Minecraft gebruikt deze route.
//
// Eerste activatie:
// HWID wordt gekoppeld.
//
// Zelfde PC:
// toegestaan.
//
// Andere PC:
// geweigerd.
//
// Na /license-reset:
// nieuwe PC kan gekoppeld worden.
// =====================================================

app.post(
    "/verify",
    async (req, res) => {

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

            const row =
                await getLicenseByKey(
                    cleanLicense
                );

            // =========================================
            // KEY BESTAAT NIET
            // =========================================

            if (!row) {

                return res.json({
                    valid: false,
                    reason: "invalid_license"
                });
            }

            // =========================================
            // DISABLED
            // =========================================

            if (!row.active) {

                return res.json({
                    valid: false,
                    reason: "disabled"
                });
            }

            // =========================================
            // EXPIRED
            // =========================================

            if (isExpired(row)) {

                return res.json({
                    valid: false,
                    reason: "expired",

                    expires_at:
                        Number(row.expires_at)
                });
            }

            // =========================================
            // EERSTE ACTIVATIE / NA HWID RESET
            // =========================================

            if (!row.hwid) {

                await pool.query(
                    `
                    UPDATE licenses
                    SET hwid = $1
                    WHERE license_key = $2
                    `,
                    [
                        cleanHwid,
                        cleanLicense
                    ]
                );

                console.log(
                    `[LICENSE] ${cleanLicense} linked to HWID`
                );

                return res.json({
                    valid: true,

                    reason:
                        "first_activation",

                    expires_at:
                        row.expires_at
                            ? Number(row.expires_at)
                            : null
                });
            }

            // =========================================
            // ZELFDE HWID
            // =========================================

            if (
                row.hwid === cleanHwid
            ) {

                return res.json({
                    valid: true,

                    reason:
                        "valid",

                    expires_at:
                        row.expires_at
                            ? Number(row.expires_at)
                            : null
                });
            }

            // =========================================
            // ANDERE PC
            // =========================================

            return res.json({
                valid: false,
                reason: "hwid_mismatch"
            });

        } catch (error) {

            console.error(
                "[VERIFY ERROR]",
                error
            );

            return res.status(500).json({
                valid: false,
                reason: "server_error"
            });
        }
    }
);

// =====================================================
// LICENSE INFO
//
// Blijft license ALTIJD tonen:
// - unused
// - activated
// - expired
// - disabled
//
// Alleen als er echt nooit een license bestond:
// found = false
// =====================================================

app.get(
    "/license-info",
    requireAdmin,
    async (req, res) => {

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
                await getLicenseByDiscord(
                    discordId
                );

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
                    row.active,

                status:
                    getLicenseStatus(row),

                created_at:
                    Number(row.created_at),

                expires_at:
                    row.expires_at
                        ? Number(row.expires_at)
                        : null,

                duration:
                    row.expires_at
                        ? "temporary"
                        : "infinite",

                hwid_reset_count:
                    row.hwid_reset_count,

                last_hwid_reset_at:
                    row.last_hwid_reset_at
                        ? Number(row.last_hwid_reset_at)
                        : null
            });

        } catch (error) {

            console.error(
                "[LICENSE INFO ERROR]",
                error
            );

            return res.status(500).json({
                success: false,
                error: "internal_server_error"
            });
        }
    }
);

// =====================================================
// RESET HWID
//
// Kan ONBEPERKT gebruikt worden.
//
// Verwijdert NIET:
// - license
// - Discord ID
// - username
// - timer
// - active status
//
// Alleen HWID wordt leeg.
// =====================================================

app.post(
    "/license-reset",
    requireAdmin,
    async (req, res) => {

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
                await getLicenseByDiscord(
                    discord_id
                );

            if (!row) {

                return res.status(404).json({
                    success: false,
                    error: "license_not_found"
                });
            }

            const now =
                Date.now();

            const result =
                await pool.query(
                    `
                    UPDATE licenses
                    SET
                        hwid = NULL,
                        hwid_reset_count =
                            hwid_reset_count + 1,
                        last_hwid_reset_at = $1
                    WHERE discord_id = $2
                    RETURNING *
                    `,
                    [
                        now,
                        String(discord_id)
                    ]
                );

            const updated =
                result.rows[0];

            console.log(
                `[LICENSE] HWID reset #${updated.hwid_reset_count} for ${updated.license_key}`
            );

            return res.json({
                success: true,

                license:
                    updated.license_key,

                hwid_reset:
                    true,

                hwid_reset_count:
                    updated.hwid_reset_count,

                last_hwid_reset_at:
                    now
            });

        } catch (error) {

            console.error(
                "[RESET ERROR]",
                error
            );

            return res.status(500).json({
                success: false,
                error: "internal_server_error"
            });
        }
    }
);

// =====================================================
// DISABLE LICENSE
//
// License wordt NIET verwijderd.
//
// Alleen:
// active = false
//
// Daardoor blijft /license-info hem tonen.
// =====================================================

app.post(
    "/license-disable",
    requireAdmin,
    async (req, res) => {

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
                await getLicenseByDiscord(
                    discord_id
                );

            if (!row) {

                return res.status(404).json({
                    success: false,
                    error: "license_not_found"
                });
            }

            const result =
                await pool.query(
                    `
                    UPDATE licenses
                    SET active = FALSE
                    WHERE discord_id = $1
                    RETURNING *
                    `,
                    [
                        String(discord_id)
                    ]
                );

            const updated =
                result.rows[0];

            console.log(
                `[LICENSE] Disabled ${updated.license_key}`
            );

            return res.json({
                success: true,

                license:
                    updated.license_key,

                status:
                    "disabled"
            });

        } catch (error) {

            console.error(
                "[DISABLE ERROR]",
                error
            );

            return res.status(500).json({
                success: false,
                error: "internal_server_error"
            });
        }
    }
);

// =====================================================
// LICENSE TIMER
//
// Voorbeelden:
// 3d
// 7d
// 30d
// 90d
// 365d
// infinite
// permanent
// lifetime
//
// BELANGRIJK:
// Timer verandert ACTIVE NIET.
//
// Dus een disabled key blijft disabled.
// =====================================================

app.post(
    "/license-timer",
    requireAdmin,
    async (req, res) => {

        try {

            const {
                discord_id,
                duration
            } = req.body;

            if (
                !discord_id ||
                !duration
            ) {

                return res.status(400).json({
                    success: false,
                    error: "missing_data"
                });
            }

            const row =
                await getLicenseByDiscord(
                    discord_id
                );

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

            // =========================================
            // PERMANENT
            // =========================================

            if (
                normalized === "infinite" ||
                normalized === "permanent" ||
                normalized === "lifetime"
            ) {

                const result =
                    await pool.query(
                        `
                        UPDATE licenses
                        SET expires_at = NULL
                        WHERE discord_id = $1
                        RETURNING *
                        `,
                        [
                            String(discord_id)
                        ]
                    );

                const updated =
                    result.rows[0];

                console.log(
                    `[LICENSE] ${updated.license_key} -> infinite`
                );

                return res.json({
                    success: true,

                    license:
                        updated.license_key,

                    duration:
                        "infinite",

                    expires_at:
                        null
                });
            }

            // =========================================
            // X DAYS
            // =========================================

            const match =
                normalized.match(
                    /^([1-9][0-9]{0,3})d$/
                );

            if (!match) {

                return res.status(400).json({
                    success: false,

                    error:
                        "invalid_duration",

                    examples: [
                        "3d",
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

            const result =
                await pool.query(
                    `
                    UPDATE licenses
                    SET expires_at = $1
                    WHERE discord_id = $2
                    RETURNING *
                    `,
                    [
                        expiresAt,
                        String(discord_id)
                    ]
                );

            const updated =
                result.rows[0];

            console.log(
                `[LICENSE] ${updated.license_key} -> ${days}d`
            );

            return res.json({
                success: true,

                license:
                    updated.license_key,

                duration:
                    `${days}d`,

                days:
                    days,

                expires_at:
                    expiresAt
            });

        } catch (error) {

            console.error(
                "[TIMER ERROR]",
                error
            );

            return res.status(500).json({
                success: false,
                error: "internal_server_error"
            });
        }
    }
);

// =====================================================
// LICENSE STOCK
// =====================================================

app.get(
    "/license-stock",
    requireAdmin,
    async (req, res) => {

        try {

            const result =
                await pool.query(`
                    SELECT *
                    FROM licenses
                `);

            const rows =
                result.rows;

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

                total:
                    rows.length,

                unused,

                activated,

                disabled,

                expired
            });

        } catch (error) {

            console.error(
                "[STOCK ERROR]",
                error
            );

            return res.status(500).json({
                success: false,
                error: "internal_server_error"
            });
        }
    }
);

// =====================================================
// 404
// =====================================================

app.use(
    (req, res) => {

        return res.status(404).json({
            success: false,
            error: "route_not_found",
            method: req.method,
            path: req.path
        });
    }
);

// =====================================================
// START SERVER
// =====================================================

const PORT =
    process.env.PORT || 3000;

async function start() {

    try {

        await setupDatabase();

        app.listen(
            PORT,
            "0.0.0.0",
            () => {

                console.log(
                    `DonutFalse License API online on port ${PORT}`
                );
            }
        );

    } catch (error) {

        console.error(
            "[STARTUP ERROR]",
            error
        );

        process.exit(1);
    }
}

start();
