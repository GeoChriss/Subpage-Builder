# Subpage Builder

A tool to automate the customization and export of reusable EJS-based subpages that can be integrated into multiple websites.

## Features

- Select subpage category (Hotels, Fantasy Sports, etc.)
- Choose GEO region (DE, NL, GR)
- Pick specific templates
- Customize domain name, site name, and subpage name
- Preview rendered results
- Export customized subpage as a ZIP file

## Project Structure

```
subpage-builder/
├── src/
│   ├── server.js
│   ├── templates/
│   │   ├── Hotels/
│   │   │   ├── DE/
│   │   │   ├── GR/
│   │   │   └── NL/
│   │   └── Fantasy/
│   │       ├── DE/
│   │       ├── GR/
│   │       └── NL/
│   ├── public/
│   └── views/
├── .env
├── package.json
└── README.md
```

## Setup

1. Install dependencies:
   ```bash
   npm install
   ```

2. Create a `.env` file with the following variables:
   ```
   PORT=3000
   NODE_ENV=development
   ```

3. Run the development server:
   ```bash
   npm run dev
   ```

4. For production:
   ```bash
   npm start
   ```

## Tech Stack

- Backend: Node.js + Express.js
- Templating: EJS
- File Handling: Node.js fs & path modules
- ZIP Creation: archiver
- Development: nodemon 