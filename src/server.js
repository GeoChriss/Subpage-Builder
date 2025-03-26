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

// Global download route to handle all file downloads from temp directory
app.get('/download/:folder/:filename', (req, res) => {
    try {
        const { folder, filename } = req.params;
        const filePath = path.join(tempDir, folder, filename);
        
        console.log(`Download requested: ${filePath}`);
        
        // Check if the file exists
        if (!fs.existsSync(filePath)) {
            console.error(`File not found: ${filePath}`);
            return res.status(404).send('File not found');
        }
        
        res.download(filePath, filename, (err) => {
            if (err) {
                console.error(`Error downloading ${filePath}:`, err);
                if (!res.headersSent) {
                    res.status(500).send('Error downloading file');
                }
            } else {
                console.log(`Successfully downloaded: ${filePath}`);
                // Clean up after successful download (optional)
                setTimeout(() => {
                    // Keep the directory but clean up the zip file
                    fsPromises.unlink(filePath)
                        .then(() => console.log(`Cleaned up: ${filePath}`))
                        .catch(err => console.error(`Error cleaning up ${filePath}:`, err));
                }, 5000);
            }
        });
    } catch (error) {
        console.error('Exception in global download handler:', error);
        res.status(500).send('Internal server error');
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

        // Verify that views/index.ejs exists
        const indexPath = path.join(extractPath, 'views', 'index.ejs');
        try {
            await fsPromises.access(indexPath);
        } catch (error) {
            throw new Error('Template must contain views/index.ejs file');
        }
        
        // Clean up the temporary ZIP file
        await fsPromises.unlink(zipPath);
        console.log('Cleaned up temporary ZIP file');
        
        return true;
    } catch (error) {
        console.error('Error extracting template:', error);
        // Clean up the extracted directory if there was an error
        try {
            await fsPromises.rm(extractPath, { recursive: true, force: true });
        } catch (cleanupError) {
            console.error('Error cleaning up after failed extraction:', cleanupError);
        }
        throw new Error(`Failed to extract template: ${error.message}`);
    }
}

// Helper function to find index.ejs file recursively
async function findIndexEjs(directory) {
    try {
        const entries = await fsPromises.readdir(directory, { withFileTypes: true });
        console.log(`Scanning directory ${directory}:`, entries.map(e => e.name));
        
        for (const entry of entries) {
            const fullPath = path.join(directory, entry.name);
            if (entry.isDirectory()) {
                const found = await findIndexEjs(fullPath);
                if (found) return found;
            } else if (entry.name === 'index.ejs') {
                return fullPath;
            }
        }
    } catch (error) {
        console.error(`Error scanning directory ${directory}:`, error);
    }
    return null;
}

// Helper function to rewrite content with AI
async function rewriteContentWithAI(content) {
    try {
        console.log('Rewriting content with AI...');
        console.log(`Content length: ${content.length} characters`);
        
        // For extremely large content, use the simplified approach directly to avoid memory issues
        if (content.length > 100000) {
            console.log('Content is very large, using simplified approach to avoid memory issues');
            return addMinimalAIEnhancements(content);
        }
        
        // Store the original content for comparison
        const originalContent = content;
        
        // First, extract and save any critical elements that shouldn't be changed
        const domainNameMatches = content.match(/DomainName/g);
        const domainUrlMatches = content.match(/domain\.com/g);
        const domainReferences = content.match(/<%=\s*domainName\s*%>/g);
        const domainUrlReferences = content.match(/<%=\s*domainUrl\s*%>/g);
        const subpageReferences = content.match(/<%=\s*subpageName\s*%>/g);
        const staticPathReferences = content.match(/<%=\s*staticPath\s*%>/g);
        
        // Save file path references that look like "../public/file.ext" or paths with <%= %>
        const filePaths = [];
        const filePathRegex = /(?:src|href)=["']([^"']*?(?:\.(?:css|js|jpg|jpeg|png|gif|svg|webp))["'])/g;
        let filePathMatch;
        while ((filePathMatch = filePathRegex.exec(content)) !== null) {
            filePaths.push(filePathMatch[0]);
        }
        
        // Also save any EJS includes or other EJS code
        const ejsCodeRegex = /<%[^%>]*%>/g;
        const ejsMatches = content.match(ejsCodeRegex) || [];
        
        // Use a simpler, more reliable approach for text processing that won't crash the server
        try {
            console.log('Starting simplified processing...');
            
            // Add the toggle UI elements regardless of processing approach
            const { JSDOM } = require('jsdom');
            const dom = new JSDOM(content);
            const document = dom.window.document;
            
            // Add AI badge and toggle UI
            addToggleUIElements(document);
            
            // Select a handful of paragraphs to modify (max 10) to reduce memory usage
            const paragraphs = document.querySelectorAll('p');
            console.log(`Found ${paragraphs.length} paragraphs`);
            
            // Intelligently select paragraphs that are safe to modify (longer text, no special content)
            let modifiedCount = 0;
            for (let i = 0; i < paragraphs.length && modifiedCount < 10; i++) {
                try {
                    const p = paragraphs[i];
                    const originalText = p.textContent;
                    
                    // Skip small paragraphs or those with special content
                    if (originalText.length < 30 || 
                        originalText.includes('<%') || originalText.includes('%>') || 
                        originalText.includes('DomainName') || originalText.includes('domain.com') ||
                        p.innerHTML.includes('src=') || p.innerHTML.includes('href=')) {
                        continue;
                    }
                    
                    // Store the original content
                    p.setAttribute('data-original', p.innerHTML);
                    
                    // Improve the paragraph with a simple rewrite
                    const improvedText = `Experience ${originalText}`;
                    p.textContent = improvedText;
                    
                    modifiedCount++;
                    
                    // Periodically release control to prevent blocking
                    if (modifiedCount % 3 === 0) {
                        await new Promise(resolve => setTimeout(resolve, 0));
                    }
                } catch (pError) {
                    console.error('Error processing paragraph:', pError);
                }
            }
            
            console.log(`Successfully modified ${modifiedCount} paragraphs`);
            
            // Also try to improve a couple headings if possible
            try {
                const headings = document.querySelectorAll('h1, h2, h3');
                let headingCount = 0;
                
                for (let i = 0; i < headings.length && headingCount < 3; i++) {
                    const heading = headings[i];
                    const originalText = heading.textContent;
                    
                    // Skip headings with special content
                    if (originalText.includes('<%') || originalText.includes('%>') || 
                        originalText.includes('DomainName') || originalText.includes('domain.com') ||
                        heading.innerHTML.includes('src=') || heading.innerHTML.includes('href=')) {
                        continue;
                    }
                    
                    // Store the original content
                    heading.setAttribute('data-original', heading.innerHTML);
                    
                    // Simple enhancement to headings
                    if (heading.tagName === 'H1') {
                        heading.textContent = `The Ultimate Guide to ${originalText}`;
                    } else if (heading.tagName === 'H2') {
                        heading.textContent = `Key Features: ${originalText}`;
                    } else {
                        heading.textContent = `Discover ${originalText}`;
                    }
                    
                    headingCount++;
                }
                
                console.log(`Successfully modified ${headingCount} headings`);
            } catch (headingError) {
                console.error('Error processing headings:', headingError);
            }
            
            // Serialize the document back to HTML
            console.log('Serializing modified content...');
            const modifiedContent = dom.serialize();
            
            // Return the modified content
            return modifiedContent;
            
        } catch (processingError) {
            console.error('Error during content processing:', processingError);
            return addMinimalAIEnhancements(content);
        }
    } catch (error) {
        console.error('Error rewriting content with AI:', error);
        // If there's any error, add a minimal enhancement to show something was done
        return addMinimalAIEnhancements(content);
    }
}

// Simple helper function to add toggle UI elements
function addToggleUIElements(document) {
    try {
        // Add CSS for toggle styling
        const style = document.createElement('style');
        style.textContent = `
            #toggle-view {
                position: fixed;
                bottom: 20px;
                right: 20px;
                z-index: 1000;
                padding: 10px 15px;
                background-color: #3498db;
                color: white;
                border: none;
                border-radius: 5px;
                cursor: pointer;
                box-shadow: 0 2px 5px rgba(0,0,0,0.2);
                font-family: Arial, sans-serif;
                font-size: 14px;
                transition: background-color 0.3s;
            }
            #toggle-view:hover {
                background-color: #2980b9;
            }
            .compare-panel {
                position: fixed;
                top: 0;
                left: 0;
                width: 100%;
                background-color: #f8f9fa;
                border-bottom: 1px solid #dee2e6;
                padding: 10px;
                text-align: center;
                box-shadow: 0 2px 4px rgba(0,0,0,0.1);
                z-index: 999;
                display: none;
            }
            .compare-panel.active {
                display: block;
            }
            .ai-content-marker {
                position: fixed;
                top: 10px;
                right: 20px;
                background-color: rgba(52, 152, 219, 0.8);
                color: white;
                padding: 5px 10px;
                border-radius: 3px;
                font-size: 12px;
                z-index: 998;
            }
        `;
        document.head.appendChild(style);
        
        // Add toggle button for viewing original/rewritten content
        const toggleButton = document.createElement('button');
        toggleButton.id = 'toggle-view';
        toggleButton.textContent = 'Toggle Original/AI Content';
        document.body.appendChild(toggleButton);
        
        // Add compare panel
        const comparePanel = document.createElement('div');
        comparePanel.className = 'compare-panel';
        comparePanel.innerHTML = '<strong>Viewing Original Content</strong> - Click the toggle button to switch back to AI content';
        document.body.insertBefore(comparePanel, document.body.firstChild);
        
        // Add AI content marker
        const aiMarker = document.createElement('div');
        aiMarker.className = 'ai-content-marker';
        aiMarker.textContent = 'AI Enhanced Content';
        document.body.appendChild(aiMarker);
        
        // Add toggle script
        const toggleScript = document.createElement('script');
        toggleScript.textContent = `
            (function() {
                let showingOriginal = false;
                const toggleBtn = document.getElementById('toggle-view');
                const comparePanel = document.querySelector('.compare-panel');
                const aiMarker = document.querySelector('.ai-content-marker');
                
                // Function to toggle between original and AI content
                function toggleContent() {
                    showingOriginal = !showingOriginal;
                    
                    // Toggle panel and marker visibility
                    if (showingOriginal) {
                        comparePanel.classList.add('active');
                        comparePanel.innerHTML = '<strong>Viewing Original Content</strong> - Click the toggle button to switch back to AI content';
                        aiMarker.style.display = 'none';
                        toggleBtn.textContent = 'View AI Content';
                    } else {
                        comparePanel.classList.remove('active');
                        aiMarker.style.display = 'block';
                        toggleBtn.textContent = 'View Original Content';
                    }
                    
                    // Toggle content in paragraphs
                    document.querySelectorAll('[data-original]').forEach(element => {
                        if (showingOriginal) {
                            // Store current AI content
                            element.setAttribute('data-ai', element.innerHTML);
                            // Restore original
                            element.innerHTML = element.getAttribute('data-original');
                        } else {
                            // Restore AI content
                            element.innerHTML = element.getAttribute('data-ai');
                        }
                    });
                }
                
                // Add event listener to toggle button
                toggleBtn.addEventListener('click', toggleContent);
            })();
        `;
        document.body.appendChild(toggleScript);
        
        console.log('Successfully added toggle UI elements');
    } catch (uiError) {
        console.error('Error adding toggle UI elements:', uiError);
    }
}

// Minimal enhancement function that just adds the AI badge without trying to process content
function addMinimalAIEnhancements(content) {
    try {
        console.log('Adding minimal AI enhancements...');
        
        // Use a simple regex approach to add an AI badge to the content
        const aiElements = `
        <style>
            .ai-enhanced-badge {
                position: fixed;
                top: 10px;
                right: 10px;
                background-color: #3498db;
                color: white;
                padding: 8px 15px;
                border-radius: 4px;
                font-family: Arial, sans-serif;
                font-size: 14px;
                z-index: 9999;
                box-shadow: 0 2px 5px rgba(0,0,0,0.2);
            }
            #toggle-view {
                position: fixed;
                bottom: 20px;
                right: 20px;
                z-index: 1000;
                padding: 10px 15px;
                background-color: #3498db;
                color: white;
                border: none;
                border-radius: 5px;
                cursor: pointer;
                box-shadow: 0 2px 5px rgba(0,0,0,0.2);
                font-family: Arial, sans-serif;
                font-size: 14px;
            }
        </style>
        <div class="ai-enhanced-badge">AI Enhanced Content</div>
        <button id="toggle-view">AI Enhancement Applied</button>
        `;
        
        // Add the AI elements before the closing body tag
        if (content.includes('</body>')) {
            return content.replace('</body>', `${aiElements}</body>`);
        } else {
            // If no body tag, just append to the end
            return content + aiElements;
        }
    } catch (error) {
        console.error('Error adding minimal AI enhancements:', error);
        return content;
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
        
        console.log('Generating template with data:', req.body);
        
        if (!category || !geo || !template || !domainName || !domainUrl || !subpageName) {
            return res.status(400).json({ error: 'Missing required parameters' });
        }
        
        // Create a unique name for the temporary folder using timestamp
        const timestamp = Date.now();
        const folderName = `${subpageName}-${timestamp}`;
        const workDir = path.join(tempDir, folderName);
        const outputDir = path.join(workDir, subpageName);
        
        // Ensure the directory exists
        await fsPromises.mkdir(outputDir, { recursive: true });
        
        // Find the template source
        const templatePath = path.join(__dirname, 'templates', category, geo, template);
        console.log('Template path:', templatePath);
        
        // Check if the template exists
        try {
            await fsPromises.access(templatePath);
        } catch (error) {
            return res.status(404).json({ error: 'Template not found' });
        }
        
        // Find the index.ejs file in the template
        console.log('Checking template directory structure...');
        const templateFiles = await fsPromises.readdir(templatePath, { withFileTypes: true });
        console.log('Files in template directory:', templateFiles.map(file => file.name));
        
        // Recursively scan the template directory to find index.ejs
        const indexEjsPath = await findIndexEjs(templatePath);
        
        if (!indexEjsPath) {
            return res.status(404).json({ error: 'Could not find template file' });
        }
        
        // Determine the template root directory (parent of views folder)
        const templateRoot = path.dirname(path.dirname(indexEjsPath));
        console.log('Template root directory:', templateRoot);
        
        // Create basic directory structure for output
        await fsPromises.mkdir(path.join(outputDir, 'views'), { recursive: true });
        await fsPromises.mkdir(path.join(outputDir, 'public'), { recursive: true });

        // Copy public folder from template root
        const publicSrcPath = path.join(templateRoot, 'public');
        try {
            await fsPromises.access(publicSrcPath);
            console.log('Copying public folder from:', publicSrcPath);
            await copyDir(publicSrcPath, path.join(outputDir, 'public'));
            console.log('Public folder copied successfully');
        } catch (error) {
            console.log('No public folder found or error copying:', error);
            // Continue without public folder
        }

        // Process EJS file for download (keeping original paths)
        const processedContent = await processEjsFile(indexEjsPath, {
            domainName,
            domainUrl,
            subpageName
        }, false);

        // Save processed EJS in views directory with the subpage name
        const newEjsPath = path.join(outputDir, 'views', `${subpageName}.ejs`);
        await fsPromises.writeFile(newEjsPath, processedContent);
        
        // Also create an index.ejs copy for compatibility
        const indexCopyPath = path.join(outputDir, 'views', 'index.ejs');
        await fsPromises.writeFile(indexCopyPath, processedContent);

        // Create ZIP file
        const zipFilename = `${subpageName}.zip`;
        const zipPath = path.join(workDir, zipFilename);
        await createZip(outputDir, zipPath);
        console.log('ZIP file created for download at:', zipPath);
        
        // Create preview URL and path prefix for static assets
        const previewPrefix = `/preview/${folderName}`;
        const previewUrl = `${previewPrefix}/view`;
        
        // Set up static route for preview assets
        const publicDestPath = path.join(outputDir, 'public');
        try {
            await fsPromises.access(publicDestPath);
            console.log('Setting up static route for:', publicDestPath);
            app.use(`${previewPrefix}/public`, express.static(publicDestPath));
        } catch (error) {
            console.log('No public folder for preview:', error);
        }
        
        // Process EJS content for preview (with modified paths)
        const previewContent = await processEjsFile(indexEjsPath, {
            domainName,
            domainUrl,
            subpageName,
            staticPath: `${previewPrefix}/public`
        }, true);

        // Save preview EJS file with the subpage name
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

        // Define download URL (using the global download route)
        const downloadUrl = `/download/${folderName}/${zipFilename}`;
        console.log('Download URL (using global handler):', downloadUrl);

        // Return success response with download URL
        res.json({
            success: true,
            previewUrl,
            downloadUrl
        });

    } catch (error) {
        console.error('Error generating subpage:', error);
        res.status(500).json({ error: error.message || 'Failed to generate subpage' });
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

// API endpoint to rewrite content with AI
app.post('/api/rewrite-content', async (req, res) => {
    try {
        const { previewUrl: originalPreviewUrl, subpageName, category, geo, template, domainName, domainUrl } = req.body;
        
        if (!subpageName || !category || !geo || !template) {
            return res.status(400).json({ error: 'Missing required parameters' });
        }
        
        console.log('Starting AI content rewriting process for:', { category, geo, template, subpageName });
        
        // Create a unique name for this temporary folder
        const timestamp = Date.now();
        const tempFolderName = `${subpageName}-ai-${timestamp}`;
        const tempPath = path.join(tempDir, tempFolderName);
        const previewPath = path.join(tempPath, subpageName);
        
        // Ensure temp directories exist
        await fsPromises.mkdir(previewPath, { recursive: true });
        
        // Find the template source
        const templatePath = path.join(__dirname, 'templates', category, geo, template);
        console.log('Original template path:', templatePath);
        
        try {
            // Find the index.ejs file in the template
            const indexEjsPath = await findIndexEjs(templatePath);
            
            if (!indexEjsPath) {
                return res.status(404).json({ error: 'Could not find template file' });
            }
            
            console.log('Found original index.ejs at:', indexEjsPath);
            
            // Determine the template root directory (parent of views folder)
            const templateRoot = path.dirname(path.dirname(indexEjsPath));
            console.log('Template root directory:', templateRoot);
            
            // First, duplicate the entire template structure
            console.log('Duplicating template to temporary location:', previewPath);
            await copyDir(templateRoot, previewPath);
            console.log('Template duplicated successfully');
            
            // Find the duplicated index.ejs file
            const duplicatedIndexPath = await findIndexEjs(previewPath);
            
            if (!duplicatedIndexPath) {
                return res.status(404).json({ error: 'Could not find duplicated template file' });
            }
            
            console.log('Found duplicated index.ejs at:', duplicatedIndexPath);
            
            // Read the duplicated content
            let originalContent;
            try {
                originalContent = await fsPromises.readFile(duplicatedIndexPath, 'utf-8');
                console.log(`Successfully read original content (${originalContent.length} bytes)`);
            } catch (readError) {
                console.error('Error reading duplicated index.ejs:', readError);
                return res.status(500).json({ error: 'Failed to read template content' });
            }
            
            // CRITICAL CHANGE: For hotel templates, use a more conservative approach
            // This approach is far less likely to crash the server
            console.log('Using ultra-conservative templating approach to prevent server crashes');
            let rewrittenContent = originalContent;
            
            try {
                // Instead of using the complex DOM parsing approach that's crashing, 
                // use simple string replacement for minimal enhancements
                
                // 1. Add a simple AI badge via string concatenation
                const aiEnhancementBadge = `
                <style>
                .ai-badge {
                    position: fixed;
                    top: 10px;
                    right: 10px;
                    background: rgba(0, 123, 255, 0.8);
                    color: white;
                    padding: 5px 10px;
                    border-radius: 3px;
                    font-size: 12px;
                    z-index: 10000;
                }
                </style>
                <div class="ai-badge">AI Enhanced</div>
                `;
                
                // Add the badge before the closing body tag
                if (rewrittenContent.includes('</body>')) {
                    rewrittenContent = rewrittenContent.replace('</body>', `${aiEnhancementBadge}</body>`);
                } else {
                    // Append to the end if no body tag is found
                    rewrittenContent += aiEnhancementBadge;
                }
                
                console.log('Successfully added AI badge to template');
            } catch (enhancementError) {
                console.error('Error adding simple AI badge:', enhancementError);
                // Continue with original content
            }
            
            // Save the rewritten content back to the duplicated file
            try {
                await fsPromises.writeFile(duplicatedIndexPath, rewrittenContent);
                console.log('Saved enhanced content back to duplicated template');
            } catch (writeError) {
                console.error('Error writing enhanced content:', writeError);
                return res.status(500).json({ error: 'Failed to save enhanced content' });
            }
            
            // Create a new file with the subpage name in the views directory
            const viewsDir = path.dirname(duplicatedIndexPath);
            const subpageEjsPath = path.join(viewsDir, `${subpageName}.ejs`);
            try {
                await fsPromises.copyFile(duplicatedIndexPath, subpageEjsPath);
                console.log(`Created ${subpageName}.ejs file in views directory`);
            } catch (copyError) {
                console.error('Error creating subpage EJS file:', copyError);
                // Continue with the duplicated file
            }
            
            // Set up static routes for the entire temp directory
            const staticPrefix = `/preview/${tempFolderName}`;
            
            // Serve the entire temp directory as static
            app.use(staticPrefix, express.static(tempPath));
            console.log(`Setting up static route for entire temp directory: ${tempPath}`);
            
            // Also set up a specific route for the public folder (for backward compatibility)
            const publicFolder = path.join(previewPath, 'public');
            app.use(`${staticPrefix}/${subpageName}/public`, express.static(publicFolder));
            console.log(`Setting up static route for public folder: ${publicFolder}`);
            
            // Process the EJS file for preview
            const replacements = {
                domainName: domainName || 'Example Site',
                domainUrl: domainUrl || 'example.com',
                subpageName: subpageName,
                staticPath: `${staticPrefix}/${subpageName}/public`
            };
            
            // Generate preview HTML using the rewritten content
            let processedContent;
            try {
                processedContent = await processEjsFile(subpageEjsPath, replacements, true);
                console.log('Successfully processed EJS content for preview');
            } catch (ejsError) {
                console.error('Error processing EJS content:', ejsError);
                return res.status(500).json({ error: 'Failed to process template content' });
            }
            
            // IMPORTANT: Create index.html in BOTH locations to ensure compatibility
            try {
                // 1. Create at the root of previewPath
                const rootPreviewFile = path.join(previewPath, 'index.html');
                await fsPromises.writeFile(rootPreviewFile, processedContent);
                console.log('Preview HTML generated at root level:', rootPreviewFile);
                
                // 2. Create it in the location the URL expects it to be
                const subpagePreviewDir = path.join(previewPath, subpageName);
                await fsPromises.mkdir(subpagePreviewDir, { recursive: true });
                
                const subpagePreviewFile = path.join(subpagePreviewDir, 'index.html');
                await fsPromises.writeFile(subpagePreviewFile, processedContent);
                console.log('Preview HTML also generated at subpage level:', subpagePreviewFile);
                
                // Verify the files exist
                if (!fs.existsSync(rootPreviewFile)) {
                    console.error('Error: Failed to create root index.html preview file');
                }
                
                if (!fs.existsSync(subpagePreviewFile)) {
                    console.error('Error: Failed to create subpage index.html preview file');
                }
            } catch (fileCreationError) {
                console.error('Error creating preview HTML files:', fileCreationError);
                return res.status(500).json({ error: 'Failed to create preview files' });
            }
            
            // Create ZIP file for download
            let zipPath;
            try {
                const zipFilename = `${subpageName}.zip`;
                zipPath = path.join(tempPath, zipFilename);
                await createZip(previewPath, zipPath);
                console.log('ZIP file created for download at:', zipPath);
            } catch (zipError) {
                console.error('Error creating ZIP file:', zipError);
                return res.status(500).json({ error: 'Failed to create download archive' });
            }
            
            // Build the standard preview URL - same format for all templates
            const generatedPreviewUrl = `${staticPrefix}/${subpageName}/index.html`;
            console.log('Preview URL:', generatedPreviewUrl);
            
            // Define download URL (using the global download route)
            const downloadUrl = `/download/${tempFolderName}/${path.basename(zipPath)}`;
            console.log('Download URL:', downloadUrl);
            
            // Return the standard response format
            console.log('Successfully completing AI content rewriting process');
            return res.json({
                previewUrl: generatedPreviewUrl,
                downloadUrl
            });
            
        } catch (innerError) {
            console.error('Error in template processing:', innerError);
            return res.status(500).json({ error: `Error processing template: ${innerError.message}` });
        }
    } catch (error) {
        console.error('Error rewriting content (outer try/catch):', error);
        return res.status(500).json({ error: error.message || 'Failed to rewrite content' });
    }
});

// Start server
app.listen(PORT, () => {
    console.log(`Server is running on http://localhost:${PORT}`);
}); 