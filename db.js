'use strict';
/**
 * Base de datos simple basada en un archivo JSON en disco.
 * No usa librerías con compilación nativa (evita fallas de build en Render).
 * IMPORTANTE (persistencia en Render): en el plan gratuito de Render el disco
 * NO es persistente entre despliegues (se borra cada vez que se re-despliega
 * la app). Para conservar los datos entre despliegues hay que agregar un
 * "Persistent Disk" en Render y montarlo en la ruta indicada por la variable
 * de entorno DATA_DIR (por ejemplo /data). Ver README.md.
 */
const fs = require('fs');
const path = require('path');
const bcrypt = require('bcryptjs');

const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, 'data');
if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
const DATA_FILE = path.join(DATA_DIR, 'db.json');

// =====================================================================
// Parámetros administrativos (no dependen del historial salarial)
// =====================================================================
const DEFAULT_CONFIG = {
  dailyHours: 7, // jornada ordinaria diaria antes de contar horas extra
  health: 4, // % descuento salud
  pension: 4, // % descuento pensión
};

// =====================================================================
// Festivos oficiales de Colombia 2026 (Ley 51 de 1983 - Ley Emiliani,
// incluye el nuevo festivo del 13 de julio - Virgen de Chiquinquirá,
// Ley 2578 de 2026)
// =====================================================================
const COLOMBIA_HOLIDAYS_2026 = [
  { id: 1, date: '2026-01-01', name: 'Año Nuevo' },
  { id: 2, date: '2026-01-12', name: 'Día de los Reyes Magos' },
  { id: 3, date: '2026-03-23', name: 'Día de San José' },
  { id: 4, date: '2026-04-02', name: 'Jueves Santo' },
  { id: 5, date: '2026-04-03', name: 'Viernes Santo' },
  { id: 6, date: '2026-05-01', name: 'Día del Trabajo' },
  { id: 7, date: '2026-05-18', name: 'Ascensión del Señor' },
  { id: 8, date: '2026-06-08', name: 'Corpus Christi' },
  { id: 9, date: '2026-06-15', name: 'Sagrado Corazón de Jesús' },
  { id: 10, date: '2026-06-29', name: 'San Pedro y San Pablo' },
  { id: 11, date: '2026-07-13', name: 'Virgen de Chiquinquirá' },
  { id: 12, date: '2026-07-20', name: 'Día de la Independencia' },
  { id: 13, date: '2026-08-07', name: 'Batalla de Boyacá' },
  { id: 14, date: '2026-08-17', name: 'Asunción de la Virgen' },
  { id: 15, date: '2026-10-12', name: 'Día de la Raza' },
  { id: 16, date: '2026-11-02', name: 'Día de Todos los Santos' },
  { id: 17, date: '2026-11-16', name: 'Independencia de Cartagena' },
  { id: 18, date: '2026-12-08', name: 'Inmaculada Concepción' },
  { id: 19, date: '2026-12-25', name: 'Navidad' },
];

// =====================================================================
// Historial salarial (Colombia). Cada período tiene "from" y "to" (o
// to:null para el período vigente). Esto permite que la liquidación y el
// cálculo diario usen SIEMPRE la tarifa que estaba vigente en cada fecha,
// en vez de aplicar el salario actual a fechas pasadas.
// Fuente: datos de salario mínimo, jornada, recargo nocturno y recargo
// dominical/festivo suministrados por el usuario (septiembre 2026).
// =====================================================================
const DEFAULT_WAGE_HISTORY = [
  {
    id: 1, from: '2025-01-01', to: '2025-06-30',
    label: '2025 (ene - jun) · jornada 46h, recargo dominical 75%',
    salary: 1423500, transport: 200000, weeklyHours: 46, monthlyHours: 230,
    nightPremium: 35, overtimeDay: 25, overtimeNight: 75, sundayPremium: 75,
    nightStart: '21:00', nightEnd: '06:00',
  },
  {
    id: 2, from: '2025-07-01', to: '2025-07-14',
    label: '2025 (1-14 jul) · recargo dominical sube a 80%',
    salary: 1423500, transport: 200000, weeklyHours: 46, monthlyHours: 230,
    nightPremium: 35, overtimeDay: 25, overtimeNight: 75, sundayPremium: 80,
    nightStart: '21:00', nightEnd: '06:00',
  },
  {
    id: 3, from: '2025-07-15', to: '2025-12-24',
    label: '2025 (15 jul - 24 dic) · jornada baja a 44h',
    salary: 1423500, transport: 200000, weeklyHours: 44, monthlyHours: 220,
    nightPremium: 35, overtimeDay: 25, overtimeNight: 75, sundayPremium: 80,
    nightStart: '21:00', nightEnd: '06:00',
  },
  {
    id: 4, from: '2025-12-25', to: '2025-12-31',
    label: '2025 (25-31 dic) · nocturno pasa a 7:00pm-6:00am',
    salary: 1423500, transport: 200000, weeklyHours: 44, monthlyHours: 220,
    nightPremium: 35, overtimeDay: 25, overtimeNight: 75, sundayPremium: 80,
    nightStart: '19:00', nightEnd: '06:00',
  },
  {
    id: 5, from: '2026-01-01', to: '2026-06-30',
    label: '2026 (ene - jun) · nuevo salario mínimo, jornada 42h',
    salary: 1750905, transport: 249095, weeklyHours: 42, monthlyHours: 210,
    nightPremium: 35, overtimeDay: 25, overtimeNight: 75, sundayPremium: 80,
    nightStart: '19:00', nightEnd: '06:00',
  },
  {
    id: 6, from: '2026-07-01', to: null,
    label: '2026 (desde jul) · recargo dominical sube a 90% · VIGENTE',
    salary: 1750905, transport: 249095, weeklyHours: 42, monthlyHours: 210,
    nightPremium: 35, overtimeDay: 25, overtimeNight: 75, sundayPremium: 90,
    nightStart: '19:00', nightEnd: '06:00',
  },
];

function defaultData() {
  return {
    auth: null,
    sessions: {},
    workers: [],
    attendance: [],
    payrolls: [],
    settlements: [],
    holidays: JSON.parse(JSON.stringify(COLOMBIA_HOLIDAYS_2026)),
    config: JSON.parse(JSON.stringify(DEFAULT_CONFIG)),
    wageHistory: JSON.parse(JSON.stringify(DEFAULT_WAGE_HISTORY)),
    pendingOvertime: [],
  };
}

let cache = null;

function load() {
  if (cache) return cache;
  if (fs.existsSync(DATA_FILE)) {
    try {
      cache = JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'));
    } catch (e) {
      console.error('No se pudo leer la base de datos, se crea una nueva:', e.message);
      cache = defaultData();
    }
  } else {
    cache = defaultData();
  }
  // Asegura que existan todas las colecciones (por si la app se actualiza)
  const def = defaultData();
  for (const key of Object.keys(def)) {
    if (cache[key] === undefined) cache[key] = def[key];
  }
  if (!cache.auth) {
    cache.auth = { username: 'ADMIN', passwordHash: bcrypt.hashSync('ADMIN123', 10) };
  }
  save();
  return cache;
}

function save() {
  fs.writeFileSync(DATA_FILE, JSON.stringify(cache, null, 2), 'utf8');
}

function getCollection(name) {
  const data = load();
  return data[name];
}

function setCollection(name, value) {
  const data = load();
  data[name] = value;
  save();
  return value;
}

module.exports = { load, save, getCollection, setCollection, DATA_FILE };
