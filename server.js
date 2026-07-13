const express = require('express');
const cors = require('cors');
const sqlite3 = require('sqlite3').verbose();
const path = require('path');

const app = express();
const PORT = process.env.PORT || 3000;

// Sert index.html et tous les fichiers du dossier racine
app.use(express.static(__dirname));

app.use(cors());
app.use(express.json());

// 1. Temps de fabrication par article (en secondes)
const PRODUCTION_TIME_SEC = {
  espresso: 45,
  latte: 90,
  the: 90,
  sandwich_chaud: 180
};

// 2. Normes d'attente maximum sur site (en secondes)
const INDUSTRY_NORMS_SEC = {
  driving: 90,
  walking: 90
};

// Route API simple pour test
app.get('/api', (req, res) => {
  res.send('API en ligne ✔️');
});

app.listen(PORT, () => {
  console.log(`Serveur actif sur le port ${PORT}`);
});
