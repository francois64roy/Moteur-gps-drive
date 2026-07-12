const express = require('express');
const cors = require('cors');
const sqlite3 = require('sqlite3').verbose();
const path = require('path');

const app = express();
const PORT = 3000;

app.use(cors());
app.use(express.json());

// 1. Temps de fabrication par article (en secondes)
const PRODUCTION_TIMES_SEC = {
    'espresso': 45,
    'latte': 90,
    'the': 60,
    'sandwich_chaud': 180
};

// 2. Normes d'attente maximum sur site (en secondes)
const INDUSTRY_NORMS_SEC = {
    'driving': 60,
    'walking': 90
};

// INITIALISATION DE LA BASE DE DONNÉES
const dbPath = path.join(__dirname, 'database.sqlite');
const db = new sqlite3.Database(dbPath, (err) => {
    if (!err) initDatabaseTables();
});

function initDatabaseTables() {
    db.run(`CREATE TABLE IF NOT EXISTS active_orders (
        id TEXT PRIMARY KEY,
        deviceId TEXT,
        items TEXT,
        status TEXT,
        etaSeconds INTEGER,
        mode TEXT,
        arrivalTimestamp INTEGER,
        countdown INTEGER
    )`);

    db.get("SELECT COUNT(*) as count FROM active_orders", [], (err, row) => {
        if (!err && row.count === 0) {
            db.run(`INSERT INTO active_orders (id, deviceId, items, status, etaSeconds, mode, arrivalTimestamp, countdown) 
                    VALUES ('CMD_101', 'iphone_francois', 'sandwich_chaud', 'En attente', 300, 'driving', NULL, 0)`);
        }
    });
}

function getRequiredProductionTime(itemsArray) {
    return Math.max(...itemsArray.map(item => PRODUCTION_TIMES_SEC[item.trim()] || 30));
}

// ROUTE RECEPTION GPS SANS TOMTOM
app.post('/api/location', (req, res) => {
    const { deviceId, latitude, longitude, mode } = req.body;

    if (!deviceId || !latitude || !longitude) {
        return res.status(400).json({ error: 'Données manquantes' });
    }

    db.get("SELECT * FROM active_orders WHERE deviceId = ?", [deviceId], (err, order) => {
        // Si aucune commande n'existe pour cet iPhone, on en crée une à la volée pour le test
        if (!order) {
            db.run(`INSERT INTO active_orders (id, deviceId, items, status, etaSeconds, mode, arrivalTimestamp, countdown) 
                    VALUES ('CMD_' || LOWER(HEX(RANDOMBLOB(2))), ?, 'sandwich_chaud', 'En attente', 300, ?, NULL, 0)`, [deviceId, mode || 'driving']);
            return res.status(200).json({ status: 'Création profil de test... Renvoyez la position dans 3 secondes.' });
        }

        // SIMULATION : On réduit le temps restant fictivement de 10 secondes à chaque envoi GPS
        let etaSeconds = Math.max(0, (order.etaSeconds || 300) - 10);
        const itemsArray = order.items.split(',');
        const totalProdTime = getRequiredProductionTime(itemsArray);
        
        let currentArrivalTimestamp = order.arrivalTimestamp;
        if (etaSeconds <= 0 && !currentArrivalTimestamp) {
            currentArrivalTimestamp = Date.now();
        }

        let countdown = etaSeconds - totalProdTime;
        let status = "En approche (Patienter)";
        if (countdown <= 0) {
            status = "🚨 LANCER TOUT DE SUITE";
        } else if (countdown < 60) {
            status = "⏳ Préparer l'emballage";
        }

        db.run(`UPDATE active_orders SET etaSeconds = ?, arrivalTimestamp = ?, countdown = ?, status = ? WHERE id = ?`, 
            [etaSeconds, currentArrivalTimestamp, Math.round(countdown), status, order.id], 
            () => {
                console.clear();
                console.log(`=== GPS REÇU [${deviceId}] ===`);
                console.log(`Position : Lat ${latitude} / Lng ${longitude}`);
                console.log(`Temps de route estimé : ${Math.floor(etaSeconds / 60)}m ${etaSeconds % 60}s`);
                console.log(`Action Cuisine : ${status}`);

                res.status(200).json({ 
                    status: 'Synchronisé', 
                    countdown: Math.round(countdown),
                    etaMinutes: Math.ceil(etaSeconds / 60)
                });
            }
        );
    });
});