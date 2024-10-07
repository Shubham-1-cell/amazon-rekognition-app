const express = require('express');
const multer = require('multer');
const cors = require('cors');
const AWS = require('aws-sdk');
const fs = require('fs');
const path = require('path');
const ffmpeg = require('fluent-ffmpeg');
const ffmpegPath = require('ffmpeg-static');
const sharp = require('sharp');  // Add sharp for image resizing
require('dotenv').config();

const app = express();
const port = 5000;

// Set ffmpeg path
ffmpeg.setFfmpegPath(ffmpegPath);

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
  region: process.env.AWS_REGION
});

// Route to upload a video
app.post('/upload', upload.single('video'), async (req, res) => {
  const videoPath = path.join(__dirname, 'uploads', req.file.filename);
  console.log(`Video uploaded: ${videoPath}`); // Log the video path

  try {
    // Set image path for the extracted frame
    const outputFolder = path.join(__dirname, 'uploads');
    if (!fs.existsSync(outputFolder)) fs.mkdirSync(outputFolder);
    
    // Use ffmpeg to extract multiple frames from the uploaded video
    await extractFrames(videoPath, outputFolder);

    // Analyze all extracted frames for PPE detection
    const ppeData = await analyzePPEInFrames(outputFolder);
    
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
  const helmetData = [];

  for (const file of files) {
    const imagePath = path.join(folderPath, file);

    // Resize the image to ensure it is under 5MB, and compress it
    const resizedImageBuffer = await resizeAndCompressImage(imagePath);

    try {
      // Analyze the resized image
      const ppeResult = await analyzePPEInImage(resizedImageBuffer);
      helmetData.push({ file, ppeResult });
    } catch (error) {
      console.error(`Error detecting PPE in frame ${file}:`, error);
    }
  }

  return helmetData;
};

// Helper function to resize and compress an image using sharp
const resizeAndCompressImage = async (imagePath) => {
  let resizedImageBuffer;
  
  // Resize the image to width 1280px, keeping aspect ratio
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

//fUNCTION FOR ANALYZING PPE
const analyzePPEInImage = async (imageBuffer) => {
  const params = {
    Image: {
      Bytes: imageBuffer // Send resized image buffer to AWS Rekognition
    }
  };

  try {
    // Get full response from Rekognition
    const ppeResult = await rekognition.detectProtectiveEquipment(params).promise();
    console.log("Full PPE detection result:", JSON.stringify(ppeResult, null, 2)); // Log full result

    const persons = ppeResult.Persons;
    let perPersonResults = [];

    persons.forEach((person, index) => {
      const personID = index;

      // Face detection check
      const faceDetected = person.BodyParts.some(bp => bp.Name === 'FACE');
      const faceMaskDetected = person.BodyParts
        .filter(bp => bp.Name === 'FACE')
        .some(bp => bp.EquipmentDetections.some(ed => ed.Type === 'FACE_COVER'));

      // Head detection and helmet detection (head cover check)
      const headDetected = person.BodyParts.some(bp => bp.Name === 'HEAD');
      const headCoverDetected = person.BodyParts
        .filter(bp => bp.Name === 'HEAD')
        .some(bp => bp.EquipmentDetections.some(ed => ed.Type === 'HEAD_COVER'));

      // Protective vest detection (body protection)
      const bodyDetected = person.BodyParts.some(bp => bp.Name === 'BODY');
      const protectiveVestDetected = person.BodyParts
        .filter(bp => bp.Name === 'BODY')
        .some(bp => bp.EquipmentDetections.some(ed => ed.Type === 'BODY_COVER'));

      // Extract head detection confidence
      const headDetectedConfidence = person.BodyParts
        .filter(bp => bp.Name === 'HEAD')
        .map(bp => bp.Confidence)[0];

      // Extract head cover confidence
      const headCoverConfidence = person.BodyParts
        .filter(bp => bp.Name === 'HEAD')
        .map(bp => bp.EquipmentDetections[0]?.Confidence)[0];

      // Extract face mask confidence
      const faceMaskConfidence = person.BodyParts
        .filter(bp => bp.Name === 'FACE')
        .map(bp => bp.EquipmentDetections[0]?.Confidence)[0];

      // Extract protective vest confidence
      const protectiveVestConfidence = person.BodyParts
        .filter(bp => bp.Name === 'BODY')
        .map(bp => bp.EquipmentDetections[0]?.Confidence)[0];

      // Detect hands (left and right)
      const leftHandDetected = person.BodyParts.some(bp => bp.Name === 'LEFT_HAND');
      const leftHandCoverDetected = person.BodyParts
        .filter(bp => bp.Name === 'LEFT_HAND')
        .some(bp => bp.EquipmentDetections.some(ed => ed.Type === 'HAND_COVER'));

      const rightHandDetected = person.BodyParts.some(bp => bp.Name === 'RIGHT_HAND');
      const rightHandCoverDetected = person.BodyParts
        .filter(bp => bp.Name === 'RIGHT_HAND')
        .some(bp => bp.EquipmentDetections.some(ed => ed.Type === 'HAND_COVER'));

      // Construct person result object
      const personResult = {
        'Person ID': personID,
        'Person detected': (person.Confidence || 0).toFixed(2) + '%',
        'Face detected': faceDetected ? 'true' : 'false',
        'Face mask detected': faceMaskDetected ? 'true' : 'false',
        'Face mask detection confidence': faceMaskConfidence ? faceMaskConfidence.toFixed(2) + '%' : 'N/A',
        'Head detected': headDetected ? 'true' : 'false',
        'Helmet detected': headCoverDetected ? 'true' : 'false',
        'Head detection confidence': headDetectedConfidence ? headDetectedConfidence.toFixed(2) + '%' : 'N/A',
        'Helmet detection confidence': headCoverConfidence ? headCoverConfidence.toFixed(2) + '%' : 'N/A',
        'Protective vest detected': protectiveVestDetected ? 'true' : 'false',
        'Protective vest detection confidence': protectiveVestConfidence ? protectiveVestConfidence.toFixed(2) + '%' : 'N/A',
        'Left hand detected': leftHandDetected ? 'true' : 'false',
        'Left hand cover detected': leftHandCoverDetected ? 'true' : 'false',
        'Right hand detected': rightHandDetected ? 'true' : 'false',
        'Right hand cover detected': rightHandCoverDetected ? 'true' : 'false'
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

app.listen(port, () => {
  console.log(`Server running on http://localhost:${port}`);
});
