const express = require('express');
const multer = require('multer');
const cors = require('cors'); 
const AWS = require('aws-sdk');
const fs = require('fs');
const path = require('path');
const ffmpeg = require('fluent-ffmpeg');
require('dotenv').config();

const app = express();
const port = 5000;

// Enable CORS for all routes
app.use(cors());

// Set up Multer for video uploads
const storage = multer.diskStorage({
  destination: './uploads/',
  filename: (req, file, cb) => {
    cb(null, file.originalname);
  }
});
const upload = multer({ storage: storage });

// Initialize AWS Rekognition
const rekognition = new AWS.Rekognition({
  region: process.env.AWS_REGION,
  accessKeyId: process.env.AWS_ACCESS_KEY_ID,
  secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY
});

// Route to upload a video
app.post('/upload', upload.single('video'), async (req, res) => {
  const videoPath = path.join(__dirname, 'uploads', req.file.filename);
  const framePath = path.join(__dirname, 'uploads', `${req.file.filename.split('.')[0]}_frame.jpg`);

  try {
    // Check if the uploaded file exists
    if (!fs.existsSync(videoPath)) {
      console.error('Uploaded video not found:', videoPath);
      return res.status(400).json({ success: false, error: 'Uploaded video not found' });
    }

    // Extract a frame from the uploaded video
    ffmpeg(videoPath)
      .on('end', async () => {
        console.log('Frame extraction completed:', framePath);
        try {
          const ppeData = await analyzePPEInImage(framePath);
          res.json({ success: true, ppeData });
        } catch (error) {
          console.error('Error detecting PPE:', error);
          res.status(500).json({ success: false, error: 'Error detecting PPE' });
        }
      })
      .on('error', (err) => {
        console.error('Error extracting frame:', err.message);
        res.status(500).json({ success: false, error: 'Error processing video' });
      })
      .screenshots({
        count: 1,
        folder: 'uploads',
        filename: `${req.file.filename.split('.')[0]}_frame.jpg`,
        size: '640x480'
      });
  } catch (error) {
    console.error('Error processing video:', error.message);
    res.status(500).json({ success: false, error: 'Error processing video' });
  }
});

// Helper function to analyze PPE in an image
const analyzePPEInImage = async (imagePath) => {
  const image = fs.readFileSync(imagePath);
  const params = {
    Image: {
      Bytes: image
    }
  };

  try {
    const result = await rekognition.detectProtectiveEquipment(params).promise();
    return result;
  } catch (error) {
    console.error('Error detecting PPE with Rekognition:', error);
    throw error; 
  }
};

app.listen(port, () => {
  console.log(`Server running on http://localhost:${port}`);
});
