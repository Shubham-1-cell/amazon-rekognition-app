const mysql = require('mysql');

const db = mysql.createConnection({
  host: '127.0.0.1',
  user: 'root',
  password: 'ppeadmin',
  database: 'ppe_detection_db'
});

db.connect((err) => {
  if (err) throw err;
  console.log('Database connected successfully');
});

module.exports = db;
