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

            discord_id TEXT NOT NULL,
            discord_username TEXT,

            hwid TEXT,

            active BOOLEAN NOT NULL DEFAULT TRUE,

            created_at BIGINT NOT NULL,

            expires_at BIGINT,

            hwid_reset_count INTEGER NOT NULL DEFAULT 0,

            last_hwid_reset_at BIGINT
        )
    `);

    // =================================================
    // MIGRATION
    //
    // Oude versie had:
    // discord_id TEXT UNIQUE
    //
    // Dat voorkomt meerdere keys voor dezelfde Discord-user.
    // Deze constraint verwijderen we.
    // =================================================

    await pool.query(`
        ALTER TABLE licenses
        DROP CONSTRAINT IF EXISTS licenses_discord_id_key
    `);

    // Sneller zoeken op Discord ID
    await pool.query(`
        CREATE INDEX IF NOT EXISTS idx_licenses_discord_id
        ON licenses(discord_id)
    `);

    // Sneller latest license vinden
    await pool.query(`
        CREATE INDEX IF NOT EXISTS idx_licenses_discord_created
        ON licenses(discord_id, created_at DESC)
    `);

    console.log(
        "[DATABASE] License table ready."
    );
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

// =====================================================
// GET NEWEST LICENSE FOR DISCORD USER
// =====================================================

async function getLatestLicenseByDiscord(discordId) {

    const result =
        await pool.query(
            `
            SELECT *
            FROM licenses
            WHERE discord_id = $1
            ORDER BY created_at DESC
            LIMIT 1
            `,
            [
                String(discordId)
            ]
        );

    return result.rows[0] || null;
}

// =====================================================
// GET LICENSE BY KEY
// =====================================================

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
        version: "4.0"
    });
});

// =====================================================
// CREATE / REGENERATE LICENSE
//
// ELKE keer /license-generate:
// -> nieuwe license
//
// Oude licenses:
// -> blijven in database
// -> worden disabled
//
// Nieuwe:
// -> active
// -> nieuwe HWID binding
// =====================================================

app.post(
    "/create-key",
    requireAdmin,
    async (req, res) => {

        const client =
            await pool.connect();

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

            const discordId =
                String(discord_id);

            const username =
                discord_username
                    ? String(discord_username)
                    : null;

            await client.query("BEGIN");

            // =========================================
            // OUDE LICENSES UITZETTEN
            // =========================================

            const previous =
                await client.query(
                    `
                    UPDATE licenses
                    SET active = FALSE
                    WHERE discord_id = $1
                    AND active = TRUE
                    RETURNING license_key
                    `,
                    [
                        discordId
                    ]
                );

            // =========================================
            // NIEUWE UNIEKE KEY
            // =========================================

            let licenseKey;

            while (true) {

                licenseKey =
                    generateLicense();

                const check =
                    await client.query(
                        `
                        SELECT license_key
                        FROM licenses
                        WHERE license_key = $1
                        LIMIT 1
                        `,
                        [
                            licenseKey
                        ]
                    );

                if (
                    check.rows.length === 0
                ) {
                    break;
                }
            }

            const now =
                Date.now();

            // =========================================
            // NIEUWE LICENSE OPSLAAN
            // =========================================

            await client.query(
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
                    discordId,
                    username,
                    now
                ]
            );

            await client.query(
                "COMMIT"
            );

            console.log(
                `[LICENSE] Generated new license ${licenseKey} for ${username || discordId}`
            );

            return res.json({
                success: true,

                license:
                    licenseKey,

                discord_id:
                    discordId,

                discord_username:
                    username,

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
                    "infinite",

                previous_licenses_disabled:
                    previous.rowCount
            });

        } catch (error) {

            try {
                await client.query(
                    "ROLLBACK"
                );
            } catch {}

            console.error(
                "[CREATE KEY ERROR]",
                error
            );

            return res.status(500).json({
                success: false,
                error: "internal_server_error"
            });

        } finally {

            client.release();
        }
    }
);

// =====================================================
// VERIFY LICENSE
//
// Minecraft gebruikt deze.
//
// Oude generated keys:
// active = false
// -> disabled
//
// Nieuwe key:
// eerste PC -> HWID bind
// =====================================================

app.post(
    "/verify",
    async (req, res) => {

        try {

            const {
                license,
                hwid
            } = req.body;

            if (
                !license ||
                !hwid
            ) {

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
                        Number(
                            row.expires_at
                        )
                });
            }

            // =========================================
            // FIRST ACTIVATION / RESET
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
                            ? Number(
                                row.expires_at
                            )
                            : null
                });
            }

            // =========================================
            // SAME PC
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
                            ? Number(
                                row.expires_at
                            )
                            : null
                });
            }

            // =========================================
            // DIFFERENT PC
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
// Altijd NIEUWSTE license voor Discord-user.
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
                await getLatestLicenseByDiscord(
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
                    Number(
                        row.created_at
                    ),

                expires_at:
                    row.expires_at
                        ? Number(
                            row.expires_at
                        )
                        : null,

                duration:
                    row.expires_at
                        ? "temporary"
                        : "infinite",

                hwid_reset_count:
                    row.hwid_reset_count,

                last_hwid_reset_at:
                    row.last_hwid_reset_at
                        ? Number(
                            row.last_hwid_reset_at
                        )
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
// Onbeperkt.
//
// Alleen nieuwste license.
//
// Key blijft bestaan.
// Discord ID blijft bestaan.
// Timer blijft bestaan.
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
                await getLatestLicenseByDiscord(
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

                    WHERE license_key = $2

                    RETURNING *
                    `,
                    [
                        now,
                        row.license_key
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
// Alleen nieuwste license wordt disabled.
//
// Wordt NIET verwijderd.
//
// /license-info blijft hem tonen.
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
                await getLatestLicenseByDiscord(
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
                    WHERE license_key = $1
                    RETURNING *
                    `,
                    [
                        row.license_key
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
// Ondersteund:
// 1d
// 3d
// 7d
// 30d
// 90d
// 365d
//
// infinite
// permanent
// lifetime
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
                await getLatestLicenseByDiscord(
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
                        WHERE license_key = $1
                        RETURNING *
                        `,
                        [
                            row.license_key
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
            // NUMBER + d
            //
            // 3d works
            // 30d works
            // etc.
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
                        "1d",
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
                    WHERE license_key = $2
                    RETURNING *
                    `,
                    [
                        expiresAt,
                        row.license_key
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
//
// Alle oude licenses blijven bestaan.
//
// Oude regenerated keys tellen als Disabled.
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
// START
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
