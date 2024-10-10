const jwt = require('jsonwebtoken');
const bcrypt = require('bcryptjs');
const db = require('./db');

// Signup function
const signup = async (req, res) => {
  const { username, email, password } = req.body;
  const hashedPassword = await bcrypt.hash(password, 10);

  const sql = "INSERT INTO Users (username, email, password_hash) VALUES (?, ?, ?)";
  db.query(sql, [username, email, hashedPassword], (err, result) => {
    if (err) return res.status(500).json({ error: 'Database error' });
    res.json({ success: true, message: 'User registered' });
  });
};

// Login function
const login = async (req, res) => {
  const { username, password } = req.body;
  const sql = "SELECT * FROM Users WHERE username = ?";

  db.query(sql, [username], async (err, result) => {
    if (err || result.length === 0) return res.status(400).json({ error: 'Invalid credentials' });

    const user = result[0];
    const passwordMatch = await bcrypt.compare(password, user.password_hash);
    if (!passwordMatch) return res.status(400).json({ error: 'Invalid credentials' });

    const token = jwt.sign({ user_id: user.user_id }, 'your_jwt_secret');
    res.json({ success: true, token });
  });
};

module.exports = { signup, login };
