const express = require("express");
const Database = require("better-sqlite3");
const crypto = require("crypto");

const app = express();
const db = new Database("licenses.db");

app.use(express.json());

db.prepare(`
    CREATE TABLE IF NOT EXISTS licenses (
        license_key TEXT PRIMARY KEY,
        hwid TEXT,
        active INTEGER DEFAULT 1
    )
`).run();

function generateLicense() {
    function part() {
        return crypto.randomBytes(2).toString("hex").toUpperCase();
    }

    return `DF-${part()}-${part()}-${part()}`;
}

app.get("/", (req, res) => {
    res.send("DonutFalse License API is online!");
});

app.post("/create-key", (req, res) => {
    let licenseKey = generateLicense();

    while (
        db.prepare("SELECT * FROM licenses WHERE license_key = ?").get(licenseKey)
    ) {
        licenseKey = generateLicense();
    }

    db.prepare(`
        INSERT INTO licenses (license_key, hwid, active)
        VALUES (?, NULL, 1)
    `).run(licenseKey);

    res.json({
        success: true,
        license: licenseKey
    });
});

app.post("/verify", (req, res) => {
    const { license, hwid } = req.body;

    if (!license || !hwid) {
        return res.json({
            valid: false,
            reason: "missing_data"
        });
    }

    const row = db.prepare(`
        SELECT * FROM licenses
        WHERE license_key = ?
    `).get(license);

    if (!row) {
        return res.json({
            valid: false,
            reason: "invalid_license"
        });
    }

    if (row.active !== 1) {
        return res.json({
            valid: false,
            reason: "disabled"
        });
    }

    if (!row.hwid) {
        db.prepare(`
            UPDATE licenses
            SET hwid = ?
            WHERE license_key = ?
        `).run(hwid, license);

        return res.json({
            valid: true,
            reason: "first_activation"
        });
    }

    if (row.hwid === hwid) {
        return res.json({
            valid: true,
            reason: "valid"
        });
    }

    return res.json({
        valid: false,
        reason: "hwid_mismatch"
    });
});

const PORT = process.env.PORT || 3000;

app.listen(PORT, "0.0.0.0", () => {
    console.log(`License API draait op poort ${PORT}`);
});