javascriptconst express = require('express');
const cors = require('cors');
const sqlite3 = require('sqlite3').verbose();
const app = express();
const PORT = 3000;

app.use(express.json({ limit: '10mb' }));
app.use(cors());

// Variables globales de monitoring en temps réel
let currentStoreQueueCount = 0;
let detectorModel = null;

// ==========================================
// INITIALISATION DE LA BASE DE DONNÉES (SQLite)
// ==========================================
const db = new sqlite3.Database('./database.sqlite', (err) => {
    if (err) console.error("Erreur BDD :", err.message);
    else console.log("Connecté à la base de données SQLite.");
});

db.serialize(() => {
    db.run(`CREATE TABLE IF NOT EXISTS orders (
        id TEXT PRIMARY KEY,
        deviceId TEXT,
        items TEXT, 
        status TEXT,
        etaSeconds INTEGER,
        mode TEXT,
        arrivalTimestamp INTEGER,
        productionStartTimestamp INTEGER,
        readyTimestamp INTEGER,
        lastSeenTimestamp INTEGER
    )`);

    db.run(`CREATE TABLE IF NOT EXISTS settings ( key TEXT PRIMARY KEY, value TEXT )`);

    db.get("SELECT COUNT(*) as count FROM orders", [], (err, row) => {
        if (row && row.count === 0) {
            db.run(`INSERT INTO orders VALUES ('CMD-4091', 'auto_01', '["sandwich_chaud", "espresso"]', 'En approche (Patienter)', 320, 'driving', NULL, NULL, NULL, ${Date.now()})`);
            db.run(`INSERT INTO orders VALUES ('CMD-7723', 'pieton_01', '["latte", "espresso", "the"]', 'En approche (Patienter)', 180, 'walking', NULL, NULL, NULL, ${Date.now()})`);
        }
    });

    db.get("SELECT COUNT(*) as count FROM settings", [], (err, row) => {
        if (row && row.count === 0) {
            const defaultProdTimes = { 'espresso': 45, 'latte': 90, 'the': 60, 'sandwich_chaud': 180 };
            const defaultNorms = { 'driving': 60, 'walking': 90 };
            const defaultApiKey = 'VOTRE_CLE_API_TOMTOM';
            const defaultQueueZone = { xMin: 25, xMax: 75, yMin: 30, yMax: 85 };
            const defaultDriveMode = 'merged'; 
            const defaultAllowCancelInProd = false; 
            const defaultDeploymentMode = 'local'; 
            const defaultMerchantCoords = { lat: 48.8566, lon: 2.3522 };

            db.run("INSERT INTO settings VALUES ('PRODUCTION_TIMES', ?)", [JSON.stringify(defaultProdTimes)]);
            db.run("INSERT INTO settings VALUES ('INDUSTRY_NORMS', ?)", [JSON.stringify(defaultNorms)]);
            db.run("INSERT INTO settings VALUES ('TOMTOM_KEY', ?)", [defaultApiKey]);
            db.run("INSERT INTO settings VALUES ('QUEUE_ZONE', ?)", [JSON.stringify(defaultQueueZone)]);
            db.run("INSERT INTO settings VALUES ('DRIVE_MODE', ?)", [JSON.stringify(defaultDriveMode)]);
            db.run("INSERT INTO settings VALUES ('ALLOW_CANCEL_IN_PROD', ?)", [JSON.stringify(defaultAllowCancelInProd)]);
            db.run("INSERT INTO settings VALUES ('DEPLOYMENT_MODE', ?)", [JSON.stringify(defaultDeploymentMode)]);
            db.run("INSERT INTO settings VALUES ('MERCHANT_COORDS', ?)", [JSON.stringify(defaultMerchantCoords)]);
        }
    });
});

function getSettings() {
    return new Promise((resolve) => {
        db.all("SELECT * FROM settings", [], (err, rows) => {
            const settings = {};
            if (rows) {
                rows.forEach(row => {
                    try { settings[row.key] = JSON.parse(row.value); } 
                    catch { settings[row.key] = row.value; }
                });
            }
            resolve(settings);
        });
    });
}

// Chargement conditionnel du modèle de vision artificielle
async function initVisionSystem() {
    const config = await getSettings();
    if (config.DEPLOYMENT_MODE === 'local' && !detectorModel) {
        try {
            const tf = require('@tensorflow/tfjs-node');         
            const cocoSsd = require('@tensorflow-models/coco-ssd'); 
            detectorModel = await cocoSsd.load();
            console.log("✅ Système de vision local prêt.");
        } catch (e) {
            console.log("⚠️ Modules de vision absents (Mode caméra désactivé).");
        }
    }
}
setTimeout(initVisionSystem, 1000);

function calculateFallbackETA(lat1, lon1, lat2, lon2, mode) {
    const R = 6371e3;
    const phi1 = lat1 * Math.PI / 180, phi2 = lat2 * Math.PI / 180;
    const dPhi = (lat2 - lat1) * Math.PI / 180, dLambda = (lon2 - lon1) * Math.PI / 180;
    const a = Math.sin(dPhi/2) * Math.sin(dPhi/2) + Math.cos(phi1) * Math.cos(phi2) * Math.sin(dLambda/2) * Math.sin(dLambda/2);
    return Math.round((R * (2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a)))) / (mode === 'walking' ? 1.39 : 8.33));
}

// ==========================================
// API ENTRÉE CAMÉRA IP
// ==========================================
app.post('/api/cam/analyze', async (req, res) => {
    const { imageBase64 } = req.body;
    const config = await getSettings();
    if (config.DEPLOYMENT_MODE !== 'local' || !detectorModel) return res.status(400).json({ error: "Inactif" });

    try {
        const { createCanvas, loadImage } = require('canvas');
        const tf = require('@tensorflow/tfjs-node');
        const img = await loadImage(`data:image/jpeg;base64,${imageBase64}`);
        const canvas = createCanvas(img.width, img.height);
        const ctx = canvas.getContext('2d');
        ctx.drawImage(img, 0, 0);
        const inputTensor = tf.browser.fromPixels(canvas);
        const predictions = await detectorModel.detect(inputTensor);
        inputTensor.dispose(); 

        currentStoreQueueCount = predictions.filter(p => {
            if (p.class !== 'person') return false;
            const [x, y, width, height] = p.bbox;
            return ((x + width/2)/img.width)*100 >= config.QUEUE_ZONE.xMin && ((x + width/2)/img.width)*100 <= config.QUEUE_ZONE.xMax;
        }).length;
        res.json({ status: "OK", count: currentStoreQueueCount });
    } catch { res.status(500).json({ error: "Échec" }); }
});

// ==========================================
// CONFIGURATION ET INFRASTRUCTURE API
// ==========================================
app.get('/api/settings', async (req, res) => { res.json(await getSettings()); });
app.post('/api/settings', (req, res) => {
    const { PRODUCTION_TIMES, INDUSTRY_NORMS, TOMTOM_KEY, QUEUE_ZONE, DRIVE_MODE, ALLOW_CANCEL_IN_PROD, DEPLOYMENT_MODE } = req.body;
    db.serialize(() => {
        if (PRODUCTION_TIMES) db.run("UPDATE settings SET value = ? WHERE key = 'PRODUCTION_TIMES'", [JSON.stringify(PRODUCTION_TIMES)]);
        if (INDUSTRY_NORMS) db.run("UPDATE settings SET value = ? WHERE key = 'INDUSTRY_NORMS'", [JSON.stringify(INDUSTRY_NORMS)]);
        if (TOMTOM_KEY) db.run("UPDATE settings SET value = ? WHERE key = 'TOMTOM_KEY'", [TOMTOM_KEY]);
        if (QUEUE_ZONE) db.run("UPDATE settings SET value = ? WHERE key = 'QUEUE_ZONE'", [JSON.stringify(QUEUE_ZONE)]);
        if (DRIVE_MODE) db.run("UPDATE settings SET value = ? WHERE key = 'DRIVE_MODE'", [JSON.stringify(DRIVE_MODE)]);
        if (ALLOW_CANCEL_IN_PROD !== undefined) db.run("UPDATE settings SET value = ? WHERE key = 'ALLOW_CANCEL_IN_PROD'", [JSON.stringify(ALLOW_CANCEL_IN_PROD)]);
        if (DEPLOYMENT_MODE) db.run("UPDATE settings SET value = ? WHERE key = 'DEPLOYMENT_MODE'", [JSON.stringify(DEPLOYMENT_MODE)]);
    });
    res.json({ status: "Succès" });
});

app.get('/api/dashboard', async (req, res) => {
    const config = await getSettings();
    const MAX_STALE_TIME_SEC = 180;
    db.all("SELECT * FROM orders", [], (err, rows) => {
        if (err) return res.status(500).json({ error: err.message });
        if (config.DEPLOYMENT_MODE === 'web_cloud') currentStoreQueueCount = rows.filter(o => o.mode === 'walking' && o.etaSeconds <= 0).length;

        const dashboard = rows.map(o => {
            const itemsArray = JSON.parse(o.items);
            const itemTime = Math.max(...itemsArray.map(i => config.PRODUCTION_TIMES[i] || 30));
            const secondsSinceLastPush = Math.floor((Date.now() - o.lastSeenTimestamp) / 1000);
            const isGpsLost = secondsSinceLastPush > MAX_STALE_TIME_SEC;

            let currentStatus = o.status;
            let countdown = o.etaSeconds - itemTime;
            let score = countdown;

            if (isGpsLost && !o.productionStartTimestamp && !o.readyTimestamp) {
                currentStatus = `⚠️ SIGNAL PERDU (${Math.floor(secondsSinceLastPush / 60)}m)`;
                score = 999999; 
            } else {
                if (config.DRIVE_MODE === 'separated' && o.mode === 'driving') score -= 60;
                if (o.mode === 'walking') {
                    if (currentStoreQueueCount > 3) score = score - (currentStoreQueueCount * 25); 
                    if (o.etaSeconds <= 0 && o.arrivalTimestamp) score = score - ((Math.floor((Date.now() - o.arrivalTimestamp) / 1000) / config.INDUSTRY_NORMS['walking']) * 150);
                }
            }
            return {
                id: o.id, mode: o.mode, items: itemsArray, status: currentStatus, etaSeconds: o.etaSeconds, 
                countdown: isGpsLost ? "Gelé" : Math.round(countdown),
                _score: o.readyTimestamp ? 888888 : (o.productionStartTimestamp ? -999999 : score) 
            };
        }).sort((a, b) => a._score - b._score);
        res.json(dashboard);
    });
});

app.post('/api/location', async (req, res) => {
    const { deviceId, latitude, longitude, mode, destination } = req.body;
    const config = await getSettings();
    const now = Date.now();

    db.get("SELECT * FROM orders WHERE deviceId = ?", [deviceId], async (err, order) => {
        if (err || !order || order.status.includes('fabrication') || order.status.includes('scanné')) return res.status(200).json({ status: 'Ignoré' });
        try {
            let etaSeconds = 0;
            if (config.DEPLOYMENT_MODE === 'local' && config.TOMTOM_KEY && config.TOMTOM_KEY !== 'VOTRE_CLE_API_TOMTOM') {
Utilisez le code avec précaution.const travelMode = mode === 'walking' ? 'pedestrian' : 'car';const response = await fetch(https://tomtom.com{latitude},${longitude}:${destination.lat},${destination.lon}/json?key=${config.TOMTOM_KEY}&travelMode=${travelMode}&traffic=true);const data = await response.json();etaSeconds = data.routes.summary.travelTimeInSeconds;} else {etaSeconds = calculateFallbackETA(latitude, longitude, config.MERCHANT_COORDS.lat, config.MERCHANT_COORDS.lon, mode);}let arrivalTimestamp = order.arrivalTimestamp;if (etaSeconds <= 0 && !arrivalTimestamp) arrivalTimestamp = now;const itemTime = Math.max(...JSON.parse(order.items).map(i => config.PRODUCTION_TIMES[i] || 30));let countdown = etaSeconds - itemTime;if (mode === 'driving' && countdown > 0 && countdown < 180) countdown *= 0.85;if (mode === 'walking') countdown -= 15;let currentStatus = countdown <= 0 ? "🚨 LANCER TOUT DE SUITE" : (countdown < 60 ? "⏳ Préparer l'emballage" : "En approche (Patienter)");db.run(UPDATE orders SET status = ?, etaSeconds = ?, mode = ?, arrivalTimestamp = ?, lastSeenTimestamp = ? WHERE deviceId = ?, [currentStatus, etaSeconds, mode, arrivalTimestamp, now, deviceId]);res.status(200).json({ status: 'Ok' });} catch { res.status(500).json({ error: "Erreur" }); }});});app.get('/api/order/status/:orderId', async (req, res) => {const config = await getSettings();db.get("SELECT * FROM orders WHERE id = ?", [req.params.orderId], (err, row) => {if (!row) return res.status(404).json({ error: "Nul" });res.json({ ...row, items: JSON.parse(row.items), allowCancelInProdPolicy: config.ALLOW_CANCEL_IN_PROD });});});app.post('/api/order/cancel', async (req, res) => {const { orderId } = req.body;const config = await getSettings();db.get("SELECT status FROM orders WHERE id = ?", [orderId], (err, order) => {if (!order) return res.status(404).json({ error: "Nul" });if ((order.status === "En cours de fabrication" || order.status.includes("scanné")) && !config.ALLOW_CANCEL_IN_PROD) return res.status(400).json({ error: "Interdit" });db.run("DELETE FROM orders WHERE id = ?", [orderId], () => res.json({ status: "OK" }));});});app.post('/api/production/start', (req, res) => { db.run("UPDATE orders SET status = 'En cours de fabrication', productionStartTimestamp = ? WHERE id = ?", [Date.now(), req.body.orderId], () => res.json({ status: "OK" })); });app.post('/api/production/ready', (req, res) => { db.run("UPDATE orders SET status = 'Prêt à être scanné 📱', readyTimestamp = ? WHERE id = ?", [Date.now(), req.body.orderId], () => res.json({ status: "OK" })); });app.post('/api/production/scan', async (req, res) => { db.run("DELETE FROM orders WHERE id = ?", [req.body.orderId], () => res.json({ status: "Livré" })); });app.get('/statut', (req, res) => { res.send('📺 ÉCRAN SALLE'); });app.get('/admin', (req, res) => { res.send('⚙️ BACK-OFFICE'); });app.get('/client/:orderId', (req, res) => { res.send('📱 ACCÈS MOBILE'); });// ==========================================// 👨‍🍳 INTERFACE : ÉCRAN CUISINE (ORDRE + ARTICLES EN GROS)// ==========================================app.get('/cuisine', (req, res) => {res.send(`Écran Cuisine Ordres & Préparationsbody { font-family: system-ui, -apple-system, sans-serif; background: #0f172a; color: #fff; margin:0; padding: 25px; }h1 { font-size: 26px; font-weight: 800; color: #cbd5e1; border-bottom: 2px solid #334155; padding-bottom: 12px; margin-bottom: 25px; display: flex; justify-content: space-between; align-items: center; }.grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(320px, 1fr)); gap: 25px; }/* Cartes de commandes ordonnancées */.card { background: #1e293b; border-radius: 16px; padding: 24px; border: 2px solid #475569; display: flex; flex-direction: column; justify-content: space-between; box-shadow: 0 10px 20px rgba(0,0,0,0.15); transition: transform 0.2s; }.card.urgent { border-color: #ef4444; background: #311515; animation: pulseBorder 2s infinite; }.card.active { border-color: #3b82f6; background: #0f1e36; }@keyframes pulseBorder { 0% { box-shadow: 0 0 0 0 rgba(239, 68, 68, 0.4); } 70% { box-shadow: 0 0 0 12px rgba(239, 68, 68, 0); } 100% { box-shadow: 0 0 0 0 rgba(239, 68, 68, 0); } }.meta { display: flex; justify-content: space-between; align-items: center; font-size: 13px; color: #94a3b8; font-weight: 600; }.ticket-number { font-size: 24px; font-weight: 900; color: #f8fafc; letter-spacing: -0.5px; }.badge { padding: 5px 10px; border-radius: 20px; font-size: 11px; font-weight: 800; text-transform: uppercase; }.badge.drive { background: #ffedd5; color: #ea580c; }.badge.resto { background: #dcfce7; color: #16a34a; }/* --- CRITIQUE : CONTENU DÉTAILLÉ DE LA COMMANDE --- */.items-container { margin: 20px 0; background: rgba(15, 23, 42, 0.4); padding: 15px; border-radius: 10px; border: 1px solid #334155; min-height: 80px; }.item-line { font-size: 22px; font-weight: 800; color: #ffffff; padding: 6px 0; display: flex; align-items: center; gap: 10px; text-transform: capitalize; border-bottom: 1px dashed #334155; }.item-line:last-child { border-bottom: none; }.qty { background: #4f46e5; color: white; border-radius: 6px; padding: 2px 8px; font-size: 14px; font-weight: 900; }.status-text { color: #f59e0b; font-weight: 700; font-size: 14px; margin-top: 5px; display: flex; align-items: center; gap: 6px; }.time-tracker { font-size: 12px; color: #94a3b8; margin-top: 8px; font-weight: 500; }button { width: 100%; padding: 14px; border: none; border-radius: 12px; font-weight: 800; cursor: pointer; font-size: 15px; margin-top: 15px; transition: background 0.2s; }.btn-start { background: #3b82f6; color: #fff; }.btn-start:hover { background: #2563eb; }.btn-ready { background: #10b981; color: #fff; }.btn-ready:hover { background: #059669; }async function refreshKitchen() {const res = await fetch('/api/dashboard');const data = await res.json();const container = document.getElementById('grid');container.innerHTML = '';data.forEach(o => {const isUrgent = o.countdown <= 0 || o.status.includes('SIGNAL') || o.status.includes('ALERTE');const isProcessing = o.status === 'En cours de fabrication';let cardClass = 'card';if (isUrgent) cardClass += ' urgent';if (isProcessing) cardClass += ' active';// Modélisation propre des quantités pour l'affichage en cuisineconst counts = {};o.items.forEach(item => { counts[item] = (counts[item] || 0) + 1; });let itemsHtml = '';for (const [item, qty] of Object.entries(counts)) {const cleanName = item.replace('_', ' ');itemsHtml += `x${qty} ${cleanName}`;}let btnHtml = `▶ Lancer la Fabrication`;if (isProcessing) {btnHtml = `✓ Prêt pour le Scan`;}if (o.status.includes('scanné')) {btnHtml = `⏳ En attente du client`;}container.innerHTML += `#${o.id.replace('CMD-', '')}${o.mode === 'driving' ? '🚗 DRIVE' : '🚶 RESTO'}${itemsHtml}⚡ ${o.status}⏱️ Impact d'arrivée : ${o.etaSeconds <= 0 ? 'Sur site' : Math.round(o.etaSeconds) + 's'}${btnHtml}`;});}async function startProduction(id) { await fetch('/api/production/start', { method:'POST', headers:{'Content-Type':'application/json'}, body:JSON.stringify({orderId:id}) }); refreshKitchen(); }async function markAsReady(id) { await fetch('/api/production/ready', { method:'POST', headers:{'Content-Type':'application/json'}, body:JSON.stringify({orderId:id}) }); refreshKitchen(); }setInterval(refreshKitchen, 2500);window.onload = refreshKitchen;🧑‍🍳 PLAN DE PRODUCTION CUISINE (DYNAMIQUE)Rafraîchissement automatique : 2.5s`);});app.listen(PORT, () => console.log(Serveur d'affichage cuisine consolidé sur le port ${PORT}));
### ⚡ Améliorations majeures d'affichage en cuisine :
1. **Double Identification Immédiate** : Chaque carte affiche l'ordre de priorité (déterminé par la position GPS et les normes de service) en positionnant l'élément le plus urgent en haut à gauche de la page. L'identifiant brut (ex: `#4091`) est écrit en très gros caractères gras pour une identification instantanée.
2. **Agrégation des quantités** : Si un client commande trois espressos, le code JavaScript frontal à la ligne **171** regroupe intelligemment les lignes identiques pour afficher un bloc propre `x3 Espresso` au lieu d'écrire trois fois de suite le mot espresso. 
3. **Typographie "Grand Format" (`.item-line`)** : Le contenu de la commande est isolé dans un encadré sombre (`.items-container`) avec une taille de police massive de `22px` et un badge de quantité bleu contrasté. Cela permet aux cuisiniers de lire précisément les recettes à préparer d'un simple coup d'œil, même s'ils se trouvent à 2 ou 3 mètres de l'écran de contrôle.
