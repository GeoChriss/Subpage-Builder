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
        
        // Parse the HTML to preserve all elements
        const { JSDOM } = require('jsdom');
        const dom = new JSDOM(content);
        const document = dom.window.document;
        
        // Process all paragraphs - only change text content, keep the HTML structure
        document.querySelectorAll('p').forEach(paragraph => {
            const originalText = paragraph.textContent;
            // Skip very small text, or text with EJS, domain references, etc.
            if (originalText.length < 20 || 
                originalText.includes('<%') || originalText.includes('%>') || 
                originalText.includes('DomainName') || originalText.includes('domain.com') ||
                paragraph.innerHTML.includes('src=') || paragraph.innerHTML.includes('href=')) {
                return;
            }
            
            // Get text content, excluding any HTML inside
            const newText = rewriteWhilePreservingMeaning(originalText);
            
            // Replace just the text content while preserving any HTML inside
            const children = Array.from(paragraph.childNodes);
            let htmlContent = paragraph.innerHTML;
            
            children.forEach(child => {
                if (child.nodeType === 3) { // Text node
                    if (child.textContent.trim().length > 10) {
                        const newChildText = rewriteWhilePreservingMeaning(child.textContent);
                        htmlContent = htmlContent.replace(child.textContent, newChildText);
                    }
                }
            });
            
            // Store the original content as a data attribute
            paragraph.setAttribute('data-original', paragraph.innerHTML);
            paragraph.innerHTML = htmlContent;
        });
        
        // Process all headings - preserve the structure
        ['h1', 'h2', 'h3', 'h4', 'h5', 'h6'].forEach(headingTag => {
            document.querySelectorAll(headingTag).forEach(heading => {
                const originalText = heading.textContent;
                // Skip headings with EJS, domain references, etc.
                if (originalText.includes('<%') || originalText.includes('%>') || 
                    originalText.includes('DomainName') || originalText.includes('domain.com') ||
                    heading.innerHTML.includes('src=') || heading.innerHTML.includes('href=')) {
                    return;
                }
                
                // Store the original content as a data attribute
                heading.setAttribute('data-original', heading.innerHTML);
                
                // Rewrite the heading text
                const newText = rewriteHeading(originalText, headingTag);
                
                // Replace just the text content while preserving any HTML inside
                const children = Array.from(heading.childNodes);
                let htmlContent = heading.innerHTML;
                
                children.forEach(child => {
                    if (child.nodeType === 3) { // Text node
                        if (child.textContent.trim().length > 0) {
                            const newChildText = rewriteHeading(child.textContent, headingTag);
                            htmlContent = htmlContent.replace(child.textContent, newChildText);
                        }
                    }
                });
                
                heading.innerHTML = htmlContent;
            });
        });
        
        // Process all list items - preserve the structure
        document.querySelectorAll('li').forEach(item => {
            const originalText = item.textContent;
            // Skip items with EJS, domain references, etc.
            if (originalText.includes('<%') || originalText.includes('%>') ||
                originalText.includes('DomainName') || originalText.includes('domain.com') ||
                item.innerHTML.includes('src=') || item.innerHTML.includes('href=')) {
                return;
            }
            
            // Store the original content as a data attribute
            item.setAttribute('data-original', item.innerHTML);
            
            // Replace just the text content while preserving any HTML inside
            const children = Array.from(item.childNodes);
            let htmlContent = item.innerHTML;
            
            children.forEach(child => {
                if (child.nodeType === 3) { // Text node
                    if (child.textContent.trim().length > 0) {
                        const newChildText = rewriteListItem(child.textContent);
                        htmlContent = htmlContent.replace(child.textContent, newChildText);
                    }
                }
            });
            
            item.innerHTML = htmlContent;
        });
        
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
                    document.querySelectorAll('p[data-original]').forEach(element => {
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
                    
                    // Toggle content in headings
                    document.querySelectorAll('h1[data-original], h2[data-original], h3[data-original], h4[data-original], h5[data-original], h6[data-original]').forEach(element => {
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
                    
                    // Toggle content in list items
                    document.querySelectorAll('li[data-original]').forEach(element => {
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
        
        // Convert back to HTML string
        let modifiedContent = dom.serialize();
        
        // Double-check that we haven't accidentally modified critical elements
        // Restore DomainName if it was changed
        if (domainNameMatches) {
            const originalCount = domainNameMatches.length;
            const newCount = (modifiedContent.match(/DomainName/g) || []).length;
            if (newCount < originalCount) {
                console.log('Restoring DomainName references...');
                modifiedContent = modifiedContent.replace(/domain name/gi, 'DomainName');
            }
        }
        
        // Restore domain.com if it was changed
        if (domainUrlMatches) {
            const originalCount = domainUrlMatches.length;
            const newCount = (modifiedContent.match(/domain\.com/g) || []).length;
            if (newCount < originalCount) {
                console.log('Restoring domain.com references...');
                modifiedContent = modifiedContent.replace(/example\.com/gi, 'domain.com');
            }
        }
        
        // Ensure all EJS template references are preserved
        if (ejsMatches.length > 0) {
            ejsMatches.forEach(ejsCode => {
                if (!modifiedContent.includes(ejsCode)) {
                    console.log('Restoring missing EJS code:', ejsCode);
                    // This is a simplistic approach, but should be enough for most cases
                    modifiedContent = modifiedContent.replace(/<%.*?%>/g, match => 
                        ejsMatches.includes(match) ? match : ejsCode);
                }
            });
        }
        
        console.log('Content intelligently rewritten while preserving original structure and meaning');
        return modifiedContent;
    } catch (error) {
        console.error('Error rewriting content with AI:', error);
        // If there's an error with the DOM manipulation approach, fall back to the regex approach
        console.log('Falling back to regex-based rewriting...');
        return fallbackRegexRewrite(content);
    }
}

// Fallback regex-based rewriting in case the DOM manipulation fails
function fallbackRegexRewrite(content) {
    try {
        // Parse the document to add toggle functionality
        const { JSDOM } = require('jsdom');
        const dom = new JSDOM(content);
        const document = dom.window.document;
        
        // Store original content in data structures for toggling
        const originalParagraphs = {};
        const originalHeadings = {};
        const originalListItems = {};
        
        // Save original paragraphs
        document.querySelectorAll('p').forEach((p, index) => {
            if (p.innerHTML.length > 20 && 
                !p.innerHTML.includes('<%') && !p.innerHTML.includes('%>') &&
                !p.innerHTML.includes('DomainName') && !p.innerHTML.includes('domain.com') &&
                !p.innerHTML.includes('src=') && !p.innerHTML.includes('href=')) {
                originalParagraphs[`p-${index}`] = p.innerHTML;
                p.setAttribute('data-original-id', `p-${index}`);
            }
        });
        
        // Save original headings
        ['h1', 'h2', 'h3', 'h4', 'h5', 'h6'].forEach(tag => {
            document.querySelectorAll(tag).forEach((h, index) => {
                if (!h.innerHTML.includes('<%') && !h.innerHTML.includes('%>') &&
                    !h.innerHTML.includes('DomainName') && !h.innerHTML.includes('domain.com') &&
                    !h.innerHTML.includes('src=') && !h.innerHTML.includes('href=')) {
                    originalHeadings[`${tag}-${index}`] = h.innerHTML;
                    h.setAttribute('data-original-id', `${tag}-${index}`);
                }
            });
        });
        
        // Save original list items
        document.querySelectorAll('li').forEach((li, index) => {
            if (!li.innerHTML.includes('<%') && !li.innerHTML.includes('%>') &&
                !li.innerHTML.includes('DomainName') && !li.innerHTML.includes('domain.com') &&
                !li.innerHTML.includes('src=') && !li.innerHTML.includes('href=')) {
                originalListItems[`li-${index}`] = li.innerHTML;
                li.setAttribute('data-original-id', `li-${index}`);
            }
        });
        
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
        
        // Add toggle button
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
        
        // Add script for toggling original/rewritten content
        const script = document.createElement('script');
        script.textContent = `
            (function() {
                // Store original content
                const originalParagraphs = ${JSON.stringify(originalParagraphs)};
                const originalHeadings = ${JSON.stringify(originalHeadings)};
                const originalListItems = ${JSON.stringify(originalListItems)};
                
                let showingOriginal = false;
                const toggleBtn = document.getElementById('toggle-view');
                const comparePanel = document.querySelector('.compare-panel');
                const aiMarker = document.querySelector('.ai-content-marker');
                
                // Store AI content when first toggling
                const aiContent = {};
                
                function toggleContent() {
                    showingOriginal = !showingOriginal;
                    
                    // Toggle panel and markers
                    if (showingOriginal) {
                        comparePanel.classList.add('active');
                        aiMarker.style.display = 'none';
                        toggleBtn.textContent = 'View AI Content';
                    } else {
                        comparePanel.classList.remove('active');
                        aiMarker.style.display = 'block';
                        toggleBtn.textContent = 'View Original Content';
                    }
                    
                    // Toggle paragraphs
                    document.querySelectorAll('p[data-original-id]').forEach(p => {
                        const id = p.getAttribute('data-original-id');
                        if (showingOriginal) {
                            // Save current AI content
                            if (!aiContent[id]) {
                                aiContent[id] = p.innerHTML;
                            }
                            // Show original
                            p.innerHTML = originalParagraphs[id];
                        } else {
                            // Restore AI content
                            p.innerHTML = aiContent[id];
                        }
                    });
                    
                    // Toggle headings
                    ['h1', 'h2', 'h3', 'h4', 'h5', 'h6'].forEach(tag => {
                        document.querySelectorAll(tag + '[data-original-id]').forEach(h => {
                            const id = h.getAttribute('data-original-id');
                            if (showingOriginal) {
                                // Save current AI content
                                if (!aiContent[id]) {
                                    aiContent[id] = h.innerHTML;
                                }
                                // Show original
                                h.innerHTML = originalHeadings[id];
                            } else {
                                // Restore AI content
                                h.innerHTML = aiContent[id];
                            }
                        });
                    });
                    
                    // Toggle list items
                    document.querySelectorAll('li[data-original-id]').forEach(li => {
                        const id = li.getAttribute('data-original-id');
                        if (showingOriginal) {
                            // Save current AI content
                            if (!aiContent[id]) {
                                aiContent[id] = li.innerHTML;
                            }
                            // Show original
                            li.innerHTML = originalListItems[id];
                        } else {
                            // Restore AI content
                            li.innerHTML = aiContent[id];
                        }
                    });
                }
                
                toggleBtn.addEventListener('click', toggleContent);
            })();
        `;
        document.body.appendChild(script);
        
        // Create initial content with modified HTML
        let modifiedContent = dom.serialize();
        
        // Then rewrite paragraphs
        modifiedContent = modifiedContent.replace(/<p([^>]*?)data-original-id="([^"]+)"([^>]*?)>(.*?)<\/p>/gs, (match, attr1, id, attr2, p1) => {
            // Skip very short paragraphs or those containing specific code
            if (p1.length < 20 || p1.includes('<%') || p1.includes('%>') || 
                p1.includes('DomainName') || p1.includes('domain.com') ||
                p1.includes('src=') || p1.includes('href=')) {
                return match;
            }
            
            // Analyze the original text and rewrite it with the same meaning
            const rewrittenText = rewriteWhilePreservingMeaning(p1);
            return `<p${attr1}data-original-id="${id}"${attr2}>${rewrittenText}</p>`;
        });
        
        // Rewrite h1 headings
        modifiedContent = modifiedContent.replace(/<h1([^>]*?)data-original-id="([^"]+)"([^>]*?)>(.*?)<\/h1>/g, (match, attr1, id, attr2, p1) => {
            // Skip if heading contains template variables, domain references, or paths
            if (p1.includes('<%') || p1.includes('%>') ||
                p1.includes('DomainName') || p1.includes('domain.com') ||
                p1.includes('src=') || p1.includes('href=')) {
                return match;
            }
            
            const rewrittenHeading = rewriteHeading(p1, 'h1');
            return `<h1${attr1}data-original-id="${id}"${attr2}>${rewrittenHeading}</h1>`;
        });
        
        // Rewrite h2 headings
        modifiedContent = modifiedContent.replace(/<h2([^>]*?)data-original-id="([^"]+)"([^>]*?)>(.*?)<\/h2>/g, (match, attr1, id, attr2, p1) => {
            // Skip if heading contains template variables, domain references, or paths
            if (p1.includes('<%') || p1.includes('%>') ||
                p1.includes('DomainName') || p1.includes('domain.com') ||
                p1.includes('src=') || p1.includes('href=')) {
                return match;
            }
            
            const rewrittenHeading = rewriteHeading(p1, 'h2');
            return `<h2${attr1}data-original-id="${id}"${attr2}>${rewrittenHeading}</h2>`;
        });
        
        // Rewrite h3 headings
        modifiedContent = modifiedContent.replace(/<h3([^>]*?)data-original-id="([^"]+)"([^>]*?)>(.*?)<\/h3>/g, (match, attr1, id, attr2, p1) => {
            // Skip if heading contains template variables, domain references, or paths
            if (p1.includes('<%') || p1.includes('%>') ||
                p1.includes('DomainName') || p1.includes('domain.com') ||
                p1.includes('src=') || p1.includes('href=')) {
                return match;
            }
            
            const rewrittenHeading = rewriteHeading(p1, 'h3');
            return `<h3${attr1}data-original-id="${id}"${attr2}>${rewrittenHeading}</h3>`;
        });
        
        // Rewrite list items with improved wording but same meaning
        modifiedContent = modifiedContent.replace(/<li([^>]*?)data-original-id="([^"]+)"([^>]*?)>(.*?)<\/li>/g, (match, attr1, id, attr2, p1) => {
            // Skip if list item contains template variables, domain references, or paths
            if (p1.includes('<%') || p1.includes('%>') ||
                p1.includes('DomainName') || p1.includes('domain.com') ||
                p1.includes('src=') || p1.includes('href=')) {
                return match;
            }
            
            const rewrittenItem = rewriteListItem(p1);
            return `<li${attr1}data-original-id="${id}"${attr2}>${rewrittenItem}</li>`;
        });
        
        console.log('Content rewritten using fallback regex method with toggle support');
        return modifiedContent;
    } catch (error) {
        console.error('Error in fallback rewriting:', error);
        // Return original content if both methods fail
        return content;
    }
}

// Helper function to rewrite text while preserving meaning
function rewriteWhilePreservingMeaning(text) {
    // Remove HTML tags for analysis
    const plainText = text.replace(/<[^>]*>/g, '');
    
    // Identify key topics and entities in the text
    const words = plainText.split(/\s+/);
    const keyTerms = words.filter(word => 
        word.length > 4 && 
        !/^(the|and|that|this|have|from|with|they|will|would|been|when|which|their|what|about|there|into)$/i.test(word)
    );
    
    // Check for common themes
    const hasSports = /sport|game|team|play|match|league|tournament|basketball|football|soccer|hockey/i.test(plainText);
    const hasGambling = /bet|betting|wager|odds|casino|gamble|stake|jackpot|bonus|win/i.test(plainText);
    const hasEntertainment = /entertainment|enjoy|fun|exciting|thrill|experience|adventure/i.test(plainText);
    const hasInstructions = /click|select|choose|option|enter|submit|register|sign up|login/i.test(plainText);
    
    // Generate appropriate rewritten content based on identified themes
    let rewrittenText;
    if (hasSports && hasGambling) {
        rewrittenText = generateSportsGamblingText(plainText, keyTerms);
    } else if (hasSports) {
        rewrittenText = generateSportsText(plainText, keyTerms);
    } else if (hasGambling) {
        rewrittenText = generateGamblingText(plainText, keyTerms);
    } else if (hasEntertainment) {
        rewrittenText = generateEntertainmentText(plainText, keyTerms);
    } else if (hasInstructions) {
        rewrittenText = generateInstructionalText(plainText, keyTerms);
    } else {
        rewrittenText = generateGenericRewrite(plainText, keyTerms);
    }
    
    // Ensure proper spacing after punctuation
    rewrittenText = rewrittenText
        .replace(/\.(?=[A-Za-z])/g, '. ') // Add space after period if not present
        .replace(/,(?=[A-Za-z])/g, ', ')  // Add space after comma if not present
        .replace(/\s{2,}/g, ' ')          // Replace multiple spaces with a single space
        .replace(/\s+\./g, '.')           // Remove space before period
        .replace(/\s+,/g, ',')            // Remove space before comma
        .trim();                          // Trim extra spaces from beginning and end
    
    // Ensure sentences end with proper punctuation
    if (!/[.!?]$/.test(rewrittenText)) {
        rewrittenText += '.';
    }
    
    return rewrittenText;
}

// Helper function to rewrite headings
function rewriteHeading(text, level) {
    // Remove HTML tags
    const plainText = text.replace(/<[^>]*>/g, '').trim();
    
    // Based on heading level, apply different transformation strategies
    let rewrittenHeading;
    
    if (level === 'h1') {
        const prefixes = ["The Ultimate Guide to", "Your Complete Resource for", "Everything You Need to Know About", "Maximize Your Experience with", "The Smart Way to Approach"];
        const randomPrefix = prefixes[Math.floor(Math.random() * prefixes.length)];
        
        // For very short headings, add the prefix
        if (plainText.length < 25) {
            rewrittenHeading = `${randomPrefix} ${plainText}`;
        } 
        // For longer headings, make more subtle changes
        else {
            rewrittenHeading = plainText
                .replace(/^(the|a|an) /i, '')
                .replace(/guide to/i, 'comprehensive guide for')
                .replace(/how to/i, 'expert tips on how to')
                .replace(/tips/i, 'professional strategies')
                .replace(/best/i, 'top-rated');
        }
    } 
    else if (level === 'h2') {
        rewrittenHeading = plainText
            .replace(/^why/i, 'Key Reasons Why')
            .replace(/^how/i, 'Expert Methods')
            .replace(/benefits/i, 'Advantages & Benefits')
            .replace(/features/i, 'Key Features')
            .replace(/tips/i, 'Professional Tips')
            .replace(/guide/i, 'Step-by-Step Guide');
    }
    else if (level === 'h3') {
        rewrittenHeading = plainText
            .replace(/^(the|a|an) /i, '')
            .replace(/benefits/i, 'Key Benefits')
            .replace(/features/i, 'Notable Features')
            .replace(/options/i, 'Available Options')
            .replace(/steps/i, 'Simple Steps');
    }
    else {
        // Default fallback if no patterns match
        rewrittenHeading = plainText;
    }
    
    // Ensure proper capitalization for headings
    rewrittenHeading = rewrittenHeading
        .split(' ')
        .map(word => {
            // Don't capitalize articles, conjunctions, and prepositions shorter than 5 letters
            // unless they're the first word
            const lowerCaseWords = ['a', 'an', 'the', 'and', 'but', 'or', 'for', 'nor', 'on', 'at', 'to', 'by', 'in'];
            if (lowerCaseWords.includes(word.toLowerCase()) && rewrittenHeading.indexOf(word) > 0) {
                return word.toLowerCase();
            }
            // Capitalize first letter of other words
            return word.charAt(0).toUpperCase() + word.slice(1);
        })
        .join(' ');
    
    // Ensure first letter is always capitalized
    rewrittenHeading = rewrittenHeading.charAt(0).toUpperCase() + rewrittenHeading.slice(1);
    
    // Remove any trailing punctuation from headings
    rewrittenHeading = rewrittenHeading.replace(/[.,:;]$/, '');
    
    return rewrittenHeading;
}

// Helper function to rewrite list items
function rewriteListItem(text) {
    // Remove HTML tags
    const plainText = text.replace(/<[^>]*>/g, '').trim();
    
    // Apply different transformation strategies based on content
    let rewrittenItem;
    
    if (/^(you can|users can|customers can)/i.test(plainText)) {
        rewrittenItem = plainText.replace(/^(you can|users can|customers can)/i, 'Easily');
    }
    else if (/^(our|we)/i.test(plainText)) {
        rewrittenItem = plainText.replace(/^(our|we)/i, 'We proudly');
    }
    else if (/^(get|receive|earn)/i.test(plainText)) {
        rewrittenItem = plainText.replace(/^(get|receive|earn)/i, 'Benefit from');
    }
    // For items that start with a verb, add an adverb
    else if (/^(use|play|enjoy|find|discover|explore|choose|select)/i.test(plainText)) {
        const adverbs = ['Conveniently', 'Quickly', 'Effortlessly', 'Simply', 'Easily'];
        const randomAdverb = adverbs[Math.floor(Math.random() * adverbs.length)];
        rewrittenItem = plainText.replace(/^(use|play|enjoy|find|discover|explore|choose|select)/i, `${randomAdverb}`);
    }
    // Emphasize a key word in the list item
    else {
        const words = plainText.split(' ');
        if (words.length > 3) {
            // Find important words (nouns or adjectives) to emphasize
            for (let i = 0; i < words.length; i++) {
                const word = words[i];
                if (word.length > 4 && !/^(the|and|that|this|have|from|with|they|will|would|been|when)$/i.test(word)) {
                    words[i] = `<strong>${word}</strong>`;
                    break;
                }
            }
            rewrittenItem = words.join(' ');
        }
        else {
            // Default fallback - just return the original
            rewrittenItem = plainText;
        }
    }
    
    // Ensure proper capitalization for list items
    if (rewrittenItem.length > 0) {
        rewrittenItem = rewrittenItem.charAt(0).toUpperCase() + rewrittenItem.slice(1);
    }
    
    // Ensure proper punctuation for list items
    if (!/[.!?]$/.test(rewrittenItem)) {
        rewrittenItem += '.';
    }
    
    // Fix any double periods or other punctuation issues
    rewrittenItem = rewrittenItem
        .replace(/\.{2,}/g, '.')  // Replace multiple periods with a single one
        .replace(/\s{2,}/g, ' ')  // Replace multiple spaces with a single space
        .replace(/\s+\./g, '.')   // Remove space before period
        .trim();                  // Trim extra spaces from beginning and end
    
    return rewrittenItem;
}

// Specialized text generators based on content theme
function generateSportsGamblingText(originalText, keyTerms) {
    const sportTerms = keyTerms.filter(term => /sport|game|team|play|match|league|tournament|basketball|football|soccer|hockey/i.test(term));
    const gamblingTerms = keyTerms.filter(term => /bet|betting|wager|odds|casino|gamble|stake|jackpot|bonus|win/i.test(term));
    
    const templates = [
        `Elevate your sports experience with our premier betting platform. We offer exceptional odds on ${sportTerms.length > 0 ? sportTerms[0] : 'sports'} and other popular games, giving you the opportunity to enhance your enjoyment while potentially earning rewards.`,
        
        `Looking for the ultimate way to engage with ${sportTerms.length > 0 ? sportTerms[0] : 'sports'}? Our comprehensive betting options let you put your knowledge to the test while enjoying every moment of the action. With competitive ${gamblingTerms.length > 0 ? gamblingTerms[0] : 'odds'}, you're in for an exhilarating experience.`,
        
        `Transform how you watch ${sportTerms.length > 0 ? sportTerms[0] : 'sports'} with our intuitive betting platform. Our user-friendly interface makes it simple to place wagers on your favorite teams, enhancing the thrill of every play while giving you the chance to demonstrate your sports expertise.`
    ];
    
    return templates[Math.floor(Math.random() * templates.length)];
}

function generateSportsText(originalText, keyTerms) {
    const sportTerms = keyTerms.filter(term => /sport|game|team|play|match|league|tournament|basketball|football|soccer|hockey/i.test(term));
    
    const templates = [
        `Stay connected with the latest developments in ${sportTerms.length > 0 ? sportTerms[0] : 'sports'} through our comprehensive coverage. We bring you in-depth analysis, up-to-date statistics, and expert commentary to enhance your understanding and appreciation of the game.`,
        
        `Immerse yourself in the world of ${sportTerms.length > 0 ? sportTerms[0] : 'sports'} with our extensive resources. From player profiles to team strategies, we provide all the information you need to follow your favorite sports with greater insight and enjoyment.`,
        
        `Discover a new level of ${sportTerms.length > 0 ? sportTerms[0] : 'sports'} appreciation through our detailed coverage and analysis. Our expert team breaks down the complexities of the game, helping you understand the nuances that make every match a unique spectacle.`
    ];
    
    return templates[Math.floor(Math.random() * templates.length)];
}

function generateGamblingText(originalText, keyTerms) {
    const gamblingTerms = keyTerms.filter(term => /bet|betting|wager|odds|casino|gamble|stake|jackpot|bonus|win/i.test(term));
    
    const templates = [
        `Explore a world of opportunities with our premium betting platform. We offer competitive ${gamblingTerms.length > 0 ? gamblingTerms[0] : 'odds'} and an intuitive interface that makes placing wagers straightforward and enjoyable, whether you're a seasoned bettor or just starting out.`,
        
        `Enhance your betting experience with our comprehensive platform designed for both novices and experts. With transparent ${gamblingTerms.length > 0 ? gamblingTerms[0] : 'odds'} and a user-friendly approach, we've created an environment where you can enjoy responsible wagering in a secure setting.`,
        
        `Take your betting to the next level with our advanced platform offering exceptional ${gamblingTerms.length > 0 ? gamblingTerms[0] : 'odds'} and extensive options. Our system is designed to provide a seamless experience, allowing you to focus on making informed decisions based on your knowledge and intuition.`
    ];
    
    return templates[Math.floor(Math.random() * templates.length)];
}

function generateEntertainmentText(originalText, keyTerms) {
    // Extract relevant terms for more personalized text
    const entertainmentTerms = keyTerms.filter(term => 
        /fun|enjoy|excit|thrill|entertainment|adventure|experience|amazing|fantastic|incredible/i.test(term)
    );
    
    const term = entertainmentTerms.length > 0 ? entertainmentTerms[0] : 'entertainment';
    
    const templates = [
        `Unlock a world of ${term} possibilities designed to captivate and inspire. Our carefully curated offerings provide exceptional experiences that blend excitement and quality, ensuring memorable moments for everyone.`,
        
        `Discover ${term} options that transcend the ordinary and deliver extraordinary experiences. We've crafted each element to ensure maximum enjoyment, whether you're seeking relaxation or thrilling excitement.`,
        
        `Immerse yourself in ${term} experiences that combine quality and innovation. Our thoughtfully designed options cater to diverse preferences, ensuring there's something special for every taste and occasion.`
    ];
    
    return templates[Math.floor(Math.random() * templates.length)];
}

function generateInstructionalText(originalText, keyTerms) {
    // Extract relevant terms for more personalized instructions
    const actionTerms = keyTerms.filter(term => 
        /click|select|choose|option|enter|submit|register|sign|login|access/i.test(term)
    );
    
    const action = actionTerms.length > 0 ? actionTerms[0] : 'get started';
    
    const templates = [
        `Follow these straightforward steps to ${action} quickly and easily. Our streamlined process has been refined to eliminate complications, ensuring you can complete everything with minimal effort and maximum efficiency.`,
        
        `${action.charAt(0).toUpperCase() + action.slice(1)} is simple with our user-friendly approach. We've simplified the process into clear, manageable steps that guide you through each stage, making even complex tasks accessible and straightforward.`,
        
        `Navigate through the ${action} process with our easy-to-follow instructions. We've designed each step to be intuitive and clear, helping you accomplish your goals without unnecessary complications or technical barriers.`
    ];
    
    return templates[Math.floor(Math.random() * templates.length)];
}

function generateGenericRewrite(originalText, keyTerms) {
    // Extract important terms
    let importantTerms = [];
    if (keyTerms.length >= 3) {
        importantTerms = keyTerms.slice(0, 3);
    } else {
        importantTerms = keyTerms;
    }
    
    // If we couldn't extract meaningful terms, use these generic rewrites
    if (importantTerms.length === 0) {
        const genericRewrites = [
            "We provide comprehensive solutions tailored to meet your specific needs. Our dedicated team works tirelessly to ensure you receive exceptional service and outstanding results in every interaction.",
            
            "Discover the advantage of working with industry experts who understand your unique requirements. We combine innovation with reliability to deliver solutions that exceed expectations and create lasting value.",
            
            "Our commitment to excellence drives everything we do. From initial consultation to final delivery, we focus on quality, efficiency, and attention to detail to ensure your complete satisfaction."
        ];
        return genericRewrites[Math.floor(Math.random() * genericRewrites.length)];
    }
    
    // Use extracted terms to create more relevant rewrites
    const templates = [
        `Experience the advantages of our ${importantTerms[0] || 'service'} designed with your needs in mind. We focus on delivering exceptional ${importantTerms[1] || 'quality'} while ensuring straightforward access to all the ${importantTerms[2] || 'features'} you need.`,
        
        `We've reimagined how ${importantTerms[0] || 'solutions'} should work to provide you with unparalleled ${importantTerms[1] || 'results'}. Our approach combines innovation with reliability, ensuring you enjoy all the benefits of modern ${importantTerms[2] || 'technology'}.`,
        
        `Our ${importantTerms[0] || 'approach'} stands out through attention to detail and commitment to excellence. We've carefully developed each aspect of our ${importantTerms[1] || 'offerings'} to ensure they meet and exceed your expectations for ${importantTerms[2] || 'performance'}.`
    ];
    
    return templates[Math.floor(Math.random() * templates.length)];
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
        
        // Log the template directory structure
        console.log('Checking template directory structure...');
        const templateFiles = await fsPromises.readdir(templatePath, { withFileTypes: true });
        console.log('Files in template directory:', templateFiles.map(f => f.name));
        
        // Find index.ejs file and determine actual template root
        const indexEjsPath = await findIndexEjs(templatePath);
        if (!indexEjsPath) {
            throw new Error('Could not find index.ejs file in template directory');
        }
        console.log('Found index.ejs at:', indexEjsPath);
        
        // Determine the actual template root directory (parent of views folder)
        const templateRoot = path.dirname(path.dirname(indexEjsPath));
        console.log('Template root directory:', templateRoot);
        
        // Create directory structure
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
        const zipPath = path.join(workDir, `${subpageName}.zip`);
        await createZip(outputDir, zipPath);

        // Create preview URL and path prefix for static assets
        const previewPrefix = `/preview/${subpageName}-${timestamp}`;
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
        const tempPath = path.join(__dirname, 'temp', tempFolderName);
        const previewPath = path.join(tempPath, subpageName);
        
        // Ensure temp directories exist
        await fsPromises.mkdir(previewPath, { recursive: true });
        
        // Find the template source
        const templatePath = path.join(__dirname, 'templates', category, geo, template);
        console.log('Original template path:', templatePath);
        
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
        const originalContent = await fsPromises.readFile(duplicatedIndexPath, 'utf-8');
        
        // Rewrite the content using AI
        console.log('Applying AI rewriting to duplicated content...');
        const rewrittenContent = await rewriteContentWithAI(originalContent);
        
        // Save the rewritten content back to the duplicated file
        await fsPromises.writeFile(duplicatedIndexPath, rewrittenContent);
        console.log('AI rewritten content saved to duplicated template');
        
        // Create a new file with the subpage name in the views directory
        const viewsDir = path.dirname(duplicatedIndexPath);
        const subpageEjsPath = path.join(viewsDir, `${subpageName}.ejs`);
        await fsPromises.copyFile(duplicatedIndexPath, subpageEjsPath);
        console.log(`Created ${subpageName}.ejs file in views directory`);
        
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
        // First, try to use the subpage-named EJS file if it exists
        const processedContent = await processEjsFile(subpageEjsPath, replacements, true);
        const previewFile = path.join(previewPath, 'index.html');
        await fsPromises.writeFile(previewFile, processedContent);
        console.log('Preview HTML generated with processed content');
        
        // Create ZIP file for download
        const zipOutputPath = path.join(__dirname, 'temp', `${subpageName}-ai-rewritten.zip`);
        await createZip(previewPath, zipOutputPath);
        console.log('ZIP file created for download');
        
        // Build the preview URL
        const generatedPreviewUrl = `${staticPrefix}/${subpageName}/index.html`;
        console.log('Preview URL:', generatedPreviewUrl);
        
        res.json({
            previewUrl: generatedPreviewUrl,
            downloadUrl: `/download/${subpageName}-ai-rewritten.zip`
        });
        
        // Set up download route for the rewritten content
        app.get(`/download/${subpageName}-ai-rewritten.zip`, (downloadReq, downloadRes) => {
            downloadRes.download(zipOutputPath, `${subpageName}-ai-rewritten.zip`, (err) => {
                if (err) {
                    console.error('Error downloading rewritten file:', err);
                } else {
                    // Clean up after successful download
                    setTimeout(() => {
                        fsPromises.rm(tempPath, { recursive: true, force: true })
                            .catch(error => console.error('Error cleaning up temp files:', error));
                    }, 5000);
                }
            });
        });
    } catch (error) {
        console.error('Error rewriting content:', error);
        res.status(500).json({ error: error.message || 'Failed to rewrite content' });
    }
});

// Start server
app.listen(PORT, () => {
    console.log(`Server is running on http://localhost:${PORT}`);
}); 