const { v2: cloudinary } = require('cloudinary');
const multer = require('multer');
const { Readable } = require('stream');

cloudinary.config({
  cloud_name: process.env.CLOUDINARY_CLOUD_NAME,
  api_key: process.env.CLOUDINARY_API_KEY,
  api_secret: process.env.CLOUDINARY_API_SECRET,
});

// Store files in memory for streaming to Cloudinary
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 30 * 1024 * 1024 } });

/**
 * Upload a buffer to Cloudinary and return the secure URL.
 * @param {Buffer} buffer
 * @param {string} folder - Cloudinary folder e.g. 'pawprint/posts'
 * @param {string} [resourceType='image']
 */
function uploadStream(buffer, folder, resourceType = 'image') {
  return new Promise((resolve, reject) => {
    const stream = cloudinary.uploader.upload_stream(
      { folder, resource_type: resourceType },
      (err, result) => {
        if (err) return reject(err);
        resolve(result.secure_url);
      }
    );
    Readable.from(buffer).pipe(stream);
  });
}

module.exports = { upload, uploadStream };
