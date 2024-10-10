const express = require('express');
const multer = require('multer');
const cors = require('cors');
const AWS = require('aws-sdk');
const fs = require('fs');
const ffmpeg = require('fluent-ffmpeg');
const path = require('path');
const sharp = require('sharp');
const os = require('os');
require('dotenv').config();
const bcrypt = require('bcrypt');
const jwt = require('jsonwebtoken');


// Import the authentication functions and database connection

const db = require('./db');

const app = express();
const port = process.env.PORT || 5000;


ffmpeg.setFfmpegPath('/usr/bin/ffmpeg'); 


// Enable CORS for all routes
app.use(cors());
app.use(express.json());


// Set up Multer for video uploads
const storage = multer.memoryStorage(); // Use memory storage for uploads
const upload = multer({ storage: storage });

// Initialize AWS Rekognition
const rekognition = new AWS.Rekognition({
  region: process.env.AWS_REGION
});

// Signup function
const signup = async (req, res) => {
  const { username, email, password } = req.body;

  // Check if the user already exists
  const checkUserSql = "SELECT * FROM Users WHERE username = ?";
  db.query(checkUserSql, [username], async (err, result) => {
    if (err) return res.status(500).json({ error: 'Database error' });
    if (result.length > 0) return res.status(400).json({ error: 'User already exists' });

    const hashedPassword = await bcrypt.hash(password, 10);
    const sql = "INSERT INTO Users (username, email, password_hash) VALUES (?, ?, ?)";
    db.query(sql, [username, email, hashedPassword], (err, result) => {
      if (err) return res.status(500).json({ error: 'Database error' });
      res.json({ success: true, message: 'User registered' });
    });
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

    const token = jwt.sign({ user_id: user.user_id }, process.env.JWT_SECRET, { expiresIn: '1h' });
    
    // Log user login action
    const logSql = "INSERT INTO Logs (user_id, action, login_time) VALUES (?, ?, NOW())";
    db.query(logSql, [user.user_id, 'login'], (err) => {
      if (err) console.error('Error logging login:', err);
    });

    res.json({ success: true, token });
  });
};


// Route for user signup
app.post('/signup', signup);

// Route for user login
app.post('/login', login);


app.post('/upload', upload.single('video'), async (req, res) => {
  const token = req.headers.authorization && req.headers.authorization.split(' ')[1]; // Correct token retrieval
  let user_id;

  // Verify token and extract user_id
  try {
    const decoded = jwt.verify(token, process.env.JWT_SECRET);
    user_id = decoded.user_id;
  } catch (err) {
    // Handle user_id if it's not defined
    if (user_id) {
      // Increment failed requests count
      const updateFailSql = "UPDATE Logs SET failed_requests = failed_requests + 1 WHERE user_id = ? AND action = 'upload'";
      db.query(updateFailSql, [user_id], (error) => {
        if (error) console.error('Error updating failed requests:', error);
      });
    }
  
    return res.status(401).json({ success: false, error: 'Invalid token' });
  }
  

  if (!req.file) {
    return res.status(400).json({ success: false, error: 'No file uploaded' });
  }

  const videoBuffer = req.file.buffer;

  try {
    const outputFolder = path.join(os.tmpdir(), 'frames'); // Define the output folder for frames
    fs.mkdirSync(outputFolder, { recursive: true }); // Create the folder if it doesn't exist

    // Save the video to a temporary file
    const videoPath = path.join(outputFolder, 'uploaded_video.mp4');
    fs.writeFileSync(videoPath, videoBuffer);

    // Extract frames from the video
    await extractFrames(videoPath, outputFolder);

    // Analyze the extracted frames for PPE detection
    const ppeData = await analyzePPEInFrames(outputFolder);

    

    // Increment successful requests count
    const updateSuccessSql = "UPDATE Logs SET successful_requests = successful_requests + 1 WHERE user_id = ? AND action = 'upload'";
    db.query(updateSuccessSql, [user_id], (err) => {
      if (err) console.error('Error updating successful requests:', err);
    });

    // Return PPE detection result
    res.json({ success: true, ppeData });
  } catch (error) {
    console.error('Error processing video:', error);

      // Increment failed requests count
    const updateFailSql = "UPDATE Logs SET failed_requests = failed_requests + 1 WHERE user_id = ? AND action = 'upload'";
    db.query(updateFailSql, [user_id], (err) => {
      if (err) console.error('Error updating failed requests:', err);
    }); 
    
    res.status(500).json({ success: false, error: error.message || 'Error processing video' });

    // Log the video upload action
    const logSql = "INSERT INTO Logs (user_id, action, login_time, failed_requests, successful_requests) VALUES (?, ?, NOW())";
    db.query(logSql, [user_id, 'upload'], (err) => {
      if (err) console.error('Error logging upload:', err);
    });
  }
});




// Helper function to extract multiple frames from the video
const extractFrames = (videoPath, outputFolder) => {
  return new Promise((resolve, reject) => {
    ffmpeg(videoPath)
      .on('end', () => {
        console.log('All frames extracted successfully');
        resolve();
      })
      .on('error', (err, stdout, stderr) => {
        console.error('Error extracting frames:', err);
        console.error('FFmpeg stdout:', stdout);
        console.error('FFmpeg stderr:', stderr);
        reject(err);
      })
      .output(`${outputFolder}/frame-%03d.png`) // Extract frames as frame-001.png, frame-002.png, etc.
      .fps(1) // Extract 1 frame per second
      .run();
  });
};

// Helper function to analyze all extracted frames for PPE detection
const analyzePPEInFrames = async (folderPath) => {
  const files = fs.readdirSync(folderPath).filter(file => file.endsWith('.png'));
  const ppeData = [];

  for (const file of files) {
    const imagePath = path.join(folderPath, file);

    // Resize the image to ensure it is under 5MB, and compress it
    const resizedImageBuffer = await resizeAndCompressImage(imagePath);

    try {
      // Analyze the resized image
      const ppeResult = await analyzePPEInImage(resizedImageBuffer);
      ppeData.push({ file, ppeResult });
    } catch (error) {
      console.error(`Error detecting PPE in frame ${file}:`, error);
    }
  }

  return ppeData;
};

// Helper function to resize and compress an image using sharp
const resizeAndCompressImage = async (imagePath) => {
  let resizedImageBuffer;

  try {
    resizedImageBuffer = await sharp(imagePath)
      .resize({ width: 1280 })  // Resize image width to 1280px (adjust as needed)
      .jpeg({ quality: 80 })  // Compress to ensure smaller file size
      .toBuffer();

    // Check if image size is greater than 5MB, resize further if needed
    let fileSize = resizedImageBuffer.length / 1024 / 1024;  // Size in MB
    while (fileSize > 5) {
      resizedImageBuffer = await sharp(resizedImageBuffer)
        .resize({ width: 640 })  // Reduce width further if needed
        .jpeg({ quality: 50 })  // Reduce quality further to reduce file size
        .toBuffer();
      fileSize = resizedImageBuffer.length / 1024 / 1024;
    }

  } catch (error) {
    console.error('Error resizing and compressing image:', error);
    throw error;
  }

  return resizedImageBuffer;
};

// Function for analyzing PPE
const analyzePPEInImage = async (imageBuffer) => {
  const params = {
    Image: {
      Bytes: imageBuffer // Send resized image buffer to AWS Rekognition
    }
  };

  try {
    const ppeResult = await rekognition.detectProtectiveEquipment(params).promise();
    console.log("Full PPE detection result:", JSON.stringify(ppeResult, null, 2)); // Log full result

    const persons = ppeResult.Persons;
    let perPersonResults = [];

    persons.forEach((person, index) => {
      const personID = index;

      // Extract detection results
      const faceDetected = person.BodyParts.some(bp => bp.Name === 'FACE');
      const faceMaskDetected = person.BodyParts
        .filter(bp => bp.Name === 'FACE')
        .some(bp => bp.EquipmentDetections.some(ed => ed.Type === 'FACE_COVER'));

      const headDetected = person.BodyParts.some(bp => bp.Name === 'HEAD');
      const headCoverDetected = person.BodyParts
        .filter(bp => bp.Name === 'HEAD')
        .some(bp => bp.EquipmentDetections.some(ed => ed.Type === 'HEAD_COVER'));

      const bodyDetected = person.BodyParts.some(bp => bp.Name === 'BODY');
      const protectiveVestDetected = person.BodyParts
        .filter(bp => bp.Name === 'BODY')
        .some(bp => bp.EquipmentDetections.some(ed => ed.Type === 'BODY_COVER'));

      const handsDetected = person.BodyParts.some(bp => bp.Name === 'HAND');
      const glovesDetected = person.BodyParts
        .filter(bp => bp.Name === 'HAND')
        .some(bp => bp.EquipmentDetections.some(ed => ed.Type === 'HAND_COVER')); // Add glove check

      const personResult = {
        'Person ID': personID,
        'Person detected': (person.Confidence || 0).toFixed(2) + '%',
        'Face detected': faceDetected ? 'true' : 'false',
        'Face mask detected': faceMaskDetected ? 'true' : 'false',
        'Head detected': headDetected ? 'true' : 'false',
        'Helmet detected': headCoverDetected ? 'true' : 'false',
        'Protective vest detected': protectiveVestDetected ? 'true' : 'false',
        'Hands detected': handsDetected ? 'true' : 'false',
        'Gloves detected': glovesDetected ? 'true' : 'false', // Add gloves detection result
      };

      perPersonResults.push(personResult);
    });

    return {
      'Per-person results': perPersonResults
    };

  } catch (error) {
    console.error('Error detecting PPE:', error);
    throw error;
  }
};

app.listen(port, '0.0.0.0', () => {
  console.log(`Server running on http://0.0.0.0:${port}`);
});
