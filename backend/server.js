const AWS = require('aws-sdk');
const fs = require('fs');
const path = require('path');
const ffmpeg = require('fluent-ffmpeg');
const ffmpegPath = require('ffmpeg-static');
const sharp = require('sharp'); // Add sharp for image resizing
const util = require('util');

// Set ffmpeg path
ffmpeg.setFfmpegPath(ffmpegPath);

// Initialize AWS Rekognition and S3
const rekognition = new AWS.Rekognition({
    region: process.env.AWS_REGION
});
const s3 = new AWS.S3();

// Helper function to extract frames from the video
const extractFrames = (videoPath, outputFolder) => {
    return new Promise((resolve, reject) => {
        ffmpeg(videoPath)
            .on('end', () => resolve())
            .on('error', (err) => reject(err))
            .output(`${outputFolder}/frame-%03d.png`)  // Extract frames as frame-001.png, frame-002.png, etc.
            .fps(1)  // Extract 1 frame per second
            .run();
    });
};

// Resize and compress image using sharp
const resizeAndCompressImage = async (imagePath) => {
    let resizedImageBuffer;

    try {
        resizedImageBuffer = await sharp(imagePath)
            .resize({ width: 1280 })
            .jpeg({ quality: 80 })
            .toBuffer();

        // Resize if image is greater than 5MB
        let fileSize = resizedImageBuffer.length / 1024 / 1024;  // size in MB
        while (fileSize > 5) {
            resizedImageBuffer = await sharp(resizedImageBuffer)
                .resize({ width: 640 })
                .jpeg({ quality: 50 })
                .toBuffer();
            fileSize = resizedImageBuffer.length / 1024 / 1024;
        }

    } catch (error) {
        console.error('Error resizing and compressing image:', error);
        throw error;
    }

    return resizedImageBuffer;
};

// Analyze PPE in images using Rekognition
const analyzePPEInImage = async (imageBuffer) => {
    const params = {
        Image: {
            Bytes: imageBuffer
        }
    };

    try {
        const ppeResult = await rekognition.detectProtectiveEquipment(params).promise();
        const persons = ppeResult.Persons;
        let perPersonResults = [];

        persons.forEach((person, index) => {
            const faceDetected = person.BodyParts.some(bp => bp.Name === 'FACE');
            const faceMaskDetected = person.BodyParts.filter(bp => bp.Name === 'FACE')
                .some(bp => bp.EquipmentDetections.some(ed => ed.Type === 'FACE_COVER'));

            const headDetected = person.BodyParts.some(bp => bp.Name === 'HEAD');
            const headCoverDetected = person.BodyParts.filter(bp => bp.Name === 'HEAD')
                .some(bp => bp.EquipmentDetections.some(ed => ed.Type === 'HEAD_COVER'));

            const bodyDetected = person.BodyParts.some(bp => bp.Name === 'BODY');
            const protectiveVestDetected = person.BodyParts.filter(bp => bp.Name === 'BODY')
                .some(bp => bp.EquipmentDetections.some(ed => ed.Type === 'BODY_COVER'));

            const headDetectedConfidence = person.BodyParts.filter(bp => bp.Name === 'HEAD').map(bp => bp.Confidence)[0];
            const headCoverConfidence = person.BodyParts.filter(bp => bp.Name === 'HEAD').map(bp => bp.EquipmentDetections[0]?.Confidence)[0];

            const faceMaskConfidence = person.BodyParts.filter(bp => bp.Name === 'FACE').map(bp => bp.EquipmentDetections[0]?.Confidence)[0];
            const protectiveVestConfidence = person.BodyParts.filter(bp => bp.Name === 'BODY').map(bp => bp.EquipmentDetections[0]?.Confidence)[0];

            const leftHandDetected = person.BodyParts.some(bp => bp.Name === 'LEFT_HAND');
            const leftHandCoverDetected = person.BodyParts.filter(bp => bp.Name === 'LEFT_HAND')
                .some(bp => bp.EquipmentDetections.some(ed => ed.Type === 'HAND_COVER'));

            const rightHandDetected = person.BodyParts.some(bp => bp.Name === 'RIGHT_HAND');
            const rightHandCoverDetected = person.BodyParts.filter(bp => bp.Name === 'RIGHT_HAND')
                .some(bp => bp.EquipmentDetections.some(ed => ed.Type === 'HAND_COVER'));

            const personResult = {
                'Person ID': index,
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

        return { 'Per-person results': perPersonResults };

    } catch (error) {
        console.error('Error detecting PPE:', error);
        throw error;
    }
};

exports.handler = async (event) => {
    const bucket = event.Records[0].s3.bucket.name;
    const key = decodeURIComponent(event.Records[0].s3.object.key.replace(/\+/g, ' '));
    const videoPath = `/tmp/${path.basename(key)}`;

    try {
        // Download video from S3
        const videoData = await s3.getObject({ Bucket: bucket, Key: key }).promise();
        fs.writeFileSync(videoPath, videoData.Body);

        const outputFolder = '/tmp';  // Use Lambda's /tmp directory for storage
        await extractFrames(videoPath, outputFolder);

        // Analyze the extracted frames
        const ppeData = await analyzePPEInFrames(outputFolder);
        console.log('PPE data:', ppeData);

        return {
            statusCode: 200,
            body: JSON.stringify({ success: true, ppeData })
        };
    } catch (error) {
        console.error('Error processing video:', error);
        return {
            statusCode: 500,
            body: JSON.stringify({ success: false, error: error.message })
        };
    }
};

// Analyze all extracted frames for PPE detection
const analyzePPEInFrames = async (folderPath) => {
    const files = fs.readdirSync(folderPath).filter(file => file.endsWith('.png'));
    const helmetData = [];

    for (const file of files) {
        const imagePath = path.join(folderPath, file);
        const resizedImageBuffer = await resizeAndCompressImage(imagePath);
        try {
            const ppeResult = await analyzePPEInImage(resizedImageBuffer);
            helmetData.push({ file, ppeResult });
        } catch (error) {
            console.error(`Error detecting PPE in frame ${file}:`, error);
        }
    }

    return helmetData;
};
