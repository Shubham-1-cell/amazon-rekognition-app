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

const app = express();
const port = process.env.PORT || 5000;

// Set ffmpeg path for Render (Linux deployment)
const ffmpegPath = path.join(__dirname, 'bin', 'ffmpeg');
ffmpeg.setFfmpegPath(ffmpegPath);

// Enable CORS for all routes
app.use(cors());

// Set up Multer for video uploads
const storage = multer.memoryStorage(); // Use memory storage for uploads
const upload = multer({ storage: storage });

// Initialize AWS Rekognition
const rekognition = new AWS.Rekognition({
  region: process.env.AWS_REGION
});

// Route to upload a video
app.post('/upload', upload.single('video'), async (req, res) => {
  if (!req.file) {
    return res.status(400).json({ success: false, error: 'No file uploaded' });
  }

  const videoBuffer = req.file.buffer;
  console.log(`Video uploaded: ${req.file.originalname}`); // Log the video name

  try {
    // Create a temporary directory for processing
    const tempDir = path.join(os.tmpdir(), 'uploads');
    if (!fs.existsSync(tempDir)) fs.mkdirSync(tempDir, { recursive: true });

    const videoPath = path.join(tempDir, req.file.originalname);
    
    // Save the video temporarily
    fs.writeFileSync(videoPath, videoBuffer);
    console.log(`Video saved at: ${videoPath}`); // Check if video is saved

    // Use ffmpeg to extract frames from the uploaded video
    await extractFrames(videoPath, tempDir);

    // Analyze all extracted frames for PPE detection
    const ppeData = await analyzePPEInFrames(tempDir);
    
    // Cleanup: Remove the temporary video file
    fs.unlinkSync(videoPath);

    // Remove extracted frames
    fs.readdirSync(tempDir).forEach(file => {
      const filePath = path.join(tempDir, file);
      fs.unlinkSync(filePath);
    });

    // Return PPE detection result
    res.json({ success: true, ppeData });
  } catch (error) {
    console.error('Error processing video:', error); // Log the error for debugging
    res.status(500).json({ success: false, error: error.message || 'Error processing video' });
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
      .on('error', (err) => {
        console.error('Error extracting frames:', err);
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

      const personResult = {
        'Person ID': personID,
        'Person detected': (person.Confidence || 0).toFixed(2) + '%',
        'Face detected': faceDetected ? 'true' : 'false',
        'Face mask detected': faceMaskDetected ? 'true' : 'false',
        'Head detected': headDetected ? 'true' : 'false',
        'Helmet detected': headCoverDetected ? 'true' : 'false',
        'Protective vest detected': protectiveVestDetected ? 'true' : 'false',
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
