const express = require('express');
const path = require('path');
const cors = require('cors');
const ejs = require('ejs');
const expressLayouts = require('express-ejs-layouts');
const fsPromises = require('fs').promises;
const fs = require('fs');
const archiver = require('archiver');
const multer = require('multer');
const extract = require('extract-zip');
require('dotenv').config();

const app = express();
const PORT = process.env.PORT || 3000;

// Middleware
app.use(cors());
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// Set EJS as templating engine
app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, 'views'));
app.use(expressLayouts);
app.set('layout', 'layouts/main');

// Serve static files
app.use('/public', express.static(path.join(__dirname, 'public')));

// Create temp directory if it doesn't exist
const tempDir = path.join(__dirname, 'temp');
fsPromises.mkdir(tempDir, { recursive: true }).catch(console.error);

// Create templates directory if it doesn't exist
const templatesDir = path.join(__dirname, 'templates');
fsPromises.mkdir(templatesDir, { recursive: true }).catch(console.error);

// Configure multer for file uploads
const storage = multer.diskStorage({
    destination: async function (req, file, cb) {
        const tempUploadDir = path.join(__dirname, 'temp', 'uploads');
        try {
            await fsPromises.mkdir(tempUploadDir, { recursive: true });
            cb(null, tempUploadDir);
        } catch (err) {
            cb(err);
        }
    },
    filename: function (req, file, cb) {
        cb(null, `${Date.now()}-${file.originalname}`);
    }
});

const upload = multer({ 
    storage,
    fileFilter: (req, file, cb) => {
        if (file.originalname.endsWith('.zip')) {
            cb(null, true);
        } else {
            cb(new Error('Only .zip files are allowed'));
        }
    }
});

// Helper function to get directories
async function getDirectories(path) {
    try {
        const entries = await fsPromises.readdir(path, { withFileTypes: true });
        return entries
            .filter(entry => entry.isDirectory())
            .map(dir => dir.name);
    } catch (error) {
        console.error('Error reading directory:', error);
        return [];
    }
}

// Helper function to copy directory recursively
async function copyDir(src, dest) {
    await fsPromises.mkdir(dest, { recursive: true });
    const entries = await fsPromises.readdir(src, { withFileTypes: true });

    for (const entry of entries) {
        const srcPath = path.join(src, entry.name);
        const destPath = path.join(dest, entry.name);

        if (entry.isDirectory()) {
            await copyDir(srcPath, destPath);
        } else {
            await fsPromises.copyFile(srcPath, destPath);
        }
    }
}

// Helper function to process EJS file
async function processEjsFile(filePath, replacements, isPreview = false) {
    const content = await fsPromises.readFile(filePath, 'utf-8');
    
    // Replace placeholders
    let processedContent = content
        .replace(/DomainName/g, replacements.domainName)
        .replace(/domain\.com/g, replacements.domainUrl)
        .replace(/sub-page-name/g, replacements.subpageName);

    // Only modify paths for preview, preserve original paths for the download
    if (isPreview) {
        processedContent = processedContent.replace(/\.\.\/public\//g, `${replacements.staticPath}/`);
    }

    return processedContent;
}

// Helper function to create ZIP
function createZip(sourceDir, outputPath) {
    return new Promise((resolve, reject) => {
        const output = fs.createWriteStream(outputPath);
        const archive = archiver('zip', {
            zlib: { level: 9 }
        });

        output.on('close', () => resolve());
        archive.on('error', reject);

        archive.pipe(output);
        archive.directory(sourceDir, false);
        archive.finalize();
    });
}

// Helper function to extract ZIP file
async function extractTemplate(zipPath, category, geo, name) {
    const extractPath = path.join(__dirname, 'templates', category, geo, name);
    
    try {
        console.log('Extracting template:', {
            zipPath,
            category,
            geo,
            name,
            extractPath
        });

        // Create the target directory
        await fsPromises.mkdir(extractPath, { recursive: true });
        console.log('Created target directory:', extractPath);
        
        // Extract the ZIP file
        await extract(zipPath, { dir: extractPath });
        console.log('Extracted ZIP file successfully');
        
        // Clean up the temporary ZIP file
        await fsPromises.unlink(zipPath);
        console.log('Cleaned up temporary ZIP file');
        
        return true;
    } catch (error) {
        console.error('Error extracting template:', error);
        throw new Error(`Failed to extract template: ${error.message}`);
    }
}

// Routes
app.get('/', async (req, res) => {
    try {
        const categories = await getDirectories(path.join(__dirname, 'templates'));
        res.render('index', { 
            categories,
            title: 'Subpage Builder'
        });
    } catch (error) {
        console.error('Error rendering index:', error);
        res.status(500).json({ error: 'Internal server error' });
    }
});

// API Routes
app.get('/api/geos/:category', async (req, res) => {
    try {
        const geos = await getDirectories(path.join(__dirname, 'templates', req.params.category));
        res.json(geos);
    } catch (error) {
        console.error('Error getting GEOs:', error);
        res.status(500).json({ error: 'Failed to fetch GEOs' });
    }
});

app.get('/api/templates/:category/:geo', async (req, res) => {
    try {
        const { category, geo } = req.params;
        const templatesPath = path.join(__dirname, 'templates', category, geo);
        const templates = await getDirectories(templatesPath);
        
        // Get template details
        const templateDetails = templates.map(name => ({
            name,
            thumbnail: '/public/images/template-placeholder.png',
            description: `${category} template for ${geo} region`
        }));
        
        res.json(templateDetails);
    } catch (error) {
        console.error('Error getting templates:', error);
        res.status(500).json({ error: 'Failed to fetch templates' });
    }
});

app.post('/api/generate', async (req, res) => {
    try {
        const { category, geo, template, domainName, domainUrl, subpageName } = req.body;
        console.log('Generating template with data:', { category, geo, template, domainName, domainUrl, subpageName });

        // Create unique working directory
        const timestamp = Date.now();
        const workDir = path.join(tempDir, `${subpageName}-${timestamp}`);
        const outputDir = path.join(workDir, subpageName);
        
        // Source template path
        const templatePath = path.join(__dirname, 'templates', category, geo, template);
        console.log('Template path:', templatePath);
        
        // Create directory structure
        await fsPromises.mkdir(path.join(outputDir, 'views'), { recursive: true });
        await fsPromises.mkdir(path.join(outputDir, 'public'), { recursive: true });

        // Copy public folder
        const publicSrcPath = path.join(templatePath, 'public');
        const publicDestPath = path.join(outputDir, 'public');
        await copyDir(publicSrcPath, publicDestPath);

        // Process EJS file for download (keeping original paths)
        const ejsPath = path.join(templatePath, 'views', 'index.ejs');
        const processedContent = await processEjsFile(ejsPath, {
            domainName,
            domainUrl,
            subpageName
        }, false);

        // Save processed EJS in views directory
        const newEjsPath = path.join(outputDir, 'views', `${subpageName}.ejs`);
        await fsPromises.writeFile(newEjsPath, processedContent);

        // Create ZIP file
        const zipPath = path.join(workDir, `${subpageName}.zip`);
        await createZip(outputDir, zipPath);

        // Create preview URL and path prefix for static assets
        const previewPrefix = `/preview/${subpageName}-${timestamp}`;
        const previewUrl = `${previewPrefix}/view`;
        
        // Set up static route for preview assets
        app.use(`${previewPrefix}/public`, express.static(publicDestPath));
        
        // Process EJS content for preview (with modified paths)
        const previewContent = await processEjsFile(ejsPath, {
            domainName,
            domainUrl,
            subpageName,
            staticPath: `${previewPrefix}/public`
        }, true);

        // Save preview EJS file
        const previewEjsPath = path.join(outputDir, 'views', `${subpageName}-preview.ejs`);
        await fsPromises.writeFile(previewEjsPath, previewContent);
        
        // Set up preview route
        app.get(previewUrl, (previewReq, previewRes) => {
            previewRes.render(previewEjsPath, {
                layout: false,
                domainName,
                domainUrl,
                subpageName
            });
        });

        // Return success response
        res.json({
            success: true,
            previewUrl,
            downloadUrl: `/download/${subpageName}-${timestamp}/${subpageName}.zip`
        });

        // Set up download route
        app.get(`/download/${subpageName}-${timestamp}/${subpageName}.zip`, (downloadReq, downloadRes) => {
            downloadRes.download(zipPath, `${subpageName}.zip`, (err) => {
                if (err) {
                    console.error('Error downloading file:', err);
                } else {
                    // Clean up after successful download
                    setTimeout(() => {
                        fsPromises.rm(workDir, { recursive: true, force: true })
                            .catch(console.error);
                    }, 5000);
                }
            });
        });

    } catch (error) {
        console.error('Error generating subpage:', error);
        res.status(500).json({ error: 'Failed to generate subpage' });
    }
});

// API Routes for template management
app.get('/api/categories', async (req, res) => {
    try {
        const templatesDir = path.join(__dirname, 'templates');
        await fsPromises.mkdir(templatesDir, { recursive: true });
        const entries = await fsPromises.readdir(templatesDir, { withFileTypes: true });
        const categories = entries
            .filter(entry => entry.isDirectory())
            .map(dir => dir.name);
        res.json(categories);
    } catch (error) {
        console.error('Error reading categories:', error);
        res.status(500).json({ message: 'Error fetching categories' });
    }
});

app.get('/api/geos', async (req, res) => {
    try {
        const templatesDir = path.join(__dirname, 'templates');
        await fsPromises.mkdir(templatesDir, { recursive: true });
        const entries = await fsPromises.readdir(templatesDir, { withFileTypes: true });
        const categories = entries
            .filter(entry => entry.isDirectory())
            .map(dir => dir.name);
        
        const geos = new Set();
        
        for (const category of categories) {
            const categoryPath = path.join(templatesDir, category);
            try {
                const categoryEntries = await fsPromises.readdir(categoryPath, { withFileTypes: true });
                categoryEntries
                    .filter(entry => entry.isDirectory())
                    .forEach(dir => geos.add(dir.name));
            } catch (error) {
                console.error(`Error reading GEOs for category ${category}:`, error);
            }
        }
        
        res.json(Array.from(geos));
    } catch (error) {
        console.error('Error reading GEOs:', error);
        res.status(500).json({ message: 'Error fetching GEOs' });
    }
});

app.post('/api/templates', upload.single('template'), async (req, res) => {
    try {
        console.log('Received template upload request:', {
            body: req.body,
            file: req.file
        });

        const { category, geo, name } = req.body;
        
        if (!category || !geo || !name) {
            console.error('Missing required fields:', { category, geo, name });
            return res.status(400).json({ message: 'Missing required fields in form data' });
        }

        if (!req.file) {
            console.error('No file uploaded');
            return res.status(400).json({ message: 'No template file uploaded' });
        }

        // Validate the file is a ZIP
        if (!req.file.originalname.toLowerCase().endsWith('.zip')) {
            console.error('Invalid file type:', req.file.originalname);
            return res.status(400).json({ message: 'Only ZIP files are allowed' });
        }

        // Extract the uploaded ZIP file
        await extractTemplate(req.file.path, category, geo, name);
        console.log('Template added successfully');
        
        res.json({ message: 'Template added successfully' });
    } catch (error) {
        console.error('Error adding template:', error);
        res.status(500).json({ 
            message: 'Error adding template',
            details: error.message
        });
    }
});

// Start server
app.listen(PORT, () => {
    console.log(`Server is running on http://localhost:${PORT}`);
}); 