const express = require("express");
const cors = require("cors");
const path = require("path");
const fs = require("fs");
const { execSync } = require("child_process");
const os = require("os");
const cheerio = require("cheerio");
const axios = require("axios");

/**
 * Local development server for testing providers
 */
class DevServer {
  constructor() {
    this.app = express();
    this.port = 3001;
    this.distDir = path.join(__dirname, "dist");
    this.currentDir = path.join(__dirname);

    this.setupMiddleware();
    this.setupRoutes();
  }

  setupMiddleware() {
    // Enable CORS for mobile app
    this.app.use(
      cors({
        origin: "*",
        methods: ["GET", "POST", "OPTIONS"],
        allowedHeaders: ["Content-Type", "Authorization"],
      })
    );

    // Serve static files from dist directory
    this.app.use("/dist", express.static(this.distDir));

    // JSON parsing
    this.app.use(express.json());

    // Logging
    this.app.use((req, res, next) => {
      console.log(`${new Date().toISOString()} - ${req.method} ${req.url}`);
      next();
    });
  }

  setupRoutes() {
    // Serve manifest.json
    this.app.get("/manifest.json", (req, res) => {
      const manifestPath = path.join(this.currentDir, "manifest.json");
      console.log(`Serving manifest from: ${manifestPath}`);

      if (fs.existsSync(manifestPath)) {
        res.sendFile(manifestPath);
      } else {
        res.status(404).json({ error: "Manifest not found. Run build first." });
      }
    });

    // Serve individual provider files
    this.app.get("/dist/:provider/:file", (req, res) => {
      const { provider, file } = req.params;
      const filePath = path.join(this.distDir, provider, file);

      if (fs.existsSync(filePath)) {
        res.sendFile(filePath);
      } else {
        res.status(404).json({
          error: `File not found: ${provider}/${file}`,
          hint: "Make sure to run build first",
        });
      }
    });

    // Build endpoint - trigger rebuild
    this.app.post("/build", (req, res) => {
      try {
        console.log("🔨 Triggering rebuild...");
        execSync("node build.js", { stdio: "inherit" });
        res.json({ success: true, message: "Build completed" });
      } catch (error) {
        console.error("Build failed:", error);
        res.status(500).json({
          success: false,
          error: error.message,
        });
      }
    });

    // Status endpoint
    this.app.get("/status", (req, res) => {
      const providers = this.getAvailableProviders();
      res.json({
        status: "running",
        port: this.port,
        providers: providers.length,
        providerList: providers,
        buildTime: this.getBuildTime(),
      });
    });

    // List available providers
    this.app.get("/providers", (req, res) => {
      const providers = this.getAvailableProviders();
      res.json(providers);
    });

    // Health check
    this.app.get("/health", (req, res) => {
      res.json({ status: "healthy", timestamp: new Date().toISOString() });
    });

    // Custom API Routes for Backend consumption
    this.setupApiRoutes();

    // 404 handler
    this.app.use((req, res) => {
      res.status(404).json({
        error: "Not found",
        availableEndpoints: [
          "GET /manifest.json",
          "GET /dist/:provider/:file",
          "POST /build",
          "GET /status",
          "GET /providers",
          "GET /health",
        ],
      });
    });
  }

  getProviderContext() {
    let getBaseUrl = () => "";
    try {
      const getBaseUrlPath = path.join(this.distDir, "getBaseUrl.js");
      if (fs.existsSync(getBaseUrlPath)) {
        getBaseUrl = require(getBaseUrlPath).getBaseUrl;
      }
    } catch (e) {
      console.warn("Could not load getBaseUrl.js");
    }

    return {
      axios,
      cheerio,
      getBaseUrl,
      commonHeaders: {
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
      },
      Aes: {},
    };
  }

  setupApiRoutes() {
    // API: Search
    this.app.get("/api/:provider/search", async (req, res) => {
      try {
        const { provider } = req.params;
        const { q, page = 1 } = req.query;
        if (!q) return res.status(400).json({ error: "Missing query 'q'" });

        const modulePath = path.join(this.distDir, provider, "posts.js");
        if (!fs.existsSync(modulePath)) return res.status(404).json({ error: `Provider ${provider} not found` });

        const module = require(modulePath);
        if (!module.getSearchPosts) return res.status(404).json({ error: `getSearchPosts not supported by ${provider}` });

        const signal = new AbortController().signal;
        const result = await module.getSearchPosts({
          searchQuery: q,
          page: parseInt(page),
          providerValue: provider,
          signal,
          providerContext: this.getProviderContext()
        });
        res.json(result);
      } catch (err) {
        console.error(`[API Error] Search failed for ${req.params.provider}:`, err);
        res.status(500).json({ error: err.message });
      }
    });

    // API: Meta
    this.app.get("/api/:provider/meta", async (req, res) => {
      try {
        const { provider } = req.params;
        const { link } = req.query;
        if (!link) return res.status(400).json({ error: "Missing 'link'" });

        const modulePath = path.join(this.distDir, provider, "meta.js");
        if (!fs.existsSync(modulePath)) return res.status(404).json({ error: `Provider ${provider} not found` });

        const module = require(modulePath);
        if (!module.getMeta) return res.status(404).json({ error: `getMeta not supported by ${provider}` });

        const result = await module.getMeta({ link, providerContext: this.getProviderContext() });
        res.json(result);
      } catch (err) {
        console.error(`[API Error] Meta failed for ${req.params.provider}:`, err);
        res.status(500).json({ error: err.message });
      }
    });

    // API: Episodes
    this.app.get("/api/:provider/episodes", async (req, res) => {
      try {
        const { provider } = req.params;
        const { link, url } = req.query;
        const targetUrl = link || url;
        if (!targetUrl) return res.status(400).json({ error: "Missing 'link' or 'url'" });

        const modulePath = path.join(this.distDir, provider, "episodes.js");
        if (!fs.existsSync(modulePath)) return res.status(404).json({ error: `Provider ${provider} not found` });

        const module = require(modulePath);
        if (!module.getEpisodes) return res.status(404).json({ error: `getEpisodes not supported by ${provider}` });

        const result = await module.getEpisodes({ url: targetUrl, providerContext: this.getProviderContext() });
        res.json(result);
      } catch (err) {
        console.error(`[API Error] Episodes failed for ${req.params.provider}:`, err);
        res.status(500).json({ error: err.message });
      }
    });

    // API: Stream
    this.app.get("/api/:provider/stream", async (req, res) => {
      try {
        const { provider } = req.params;
        const { link, type = "movie" } = req.query;
        if (!link) return res.status(400).json({ error: "Missing 'link'" });

        const modulePath = path.join(this.distDir, provider, "stream.js");
        if (!fs.existsSync(modulePath)) return res.status(404).json({ error: `Provider ${provider} not found` });

        const module = require(modulePath);
        if (!module.getStream) return res.status(404).json({ error: `getStream not supported by ${provider}` });

        const signal = new AbortController().signal;
        const result = await module.getStream({ link, type, signal, providerContext: this.getProviderContext() });
        res.json(result);
      } catch (err) {
        console.error(`[API Error] Stream failed for ${req.params.provider}:`, err);
        res.status(500).json({ error: err.message });
      }
    });
  }

  getAvailableProviders() {
    if (!fs.existsSync(this.distDir)) {
      return [];
    }

    return fs
      .readdirSync(this.distDir, { withFileTypes: true })
      .filter((item) => item.isDirectory())
      .map((item) => item.name);
  }

  getBuildTime() {
    const manifestPath = path.join(this.rootDir, "manifest.json");
    if (fs.existsSync(manifestPath)) {
      const stats = fs.statSync(manifestPath);
      return stats.mtime.toISOString();
    }
    return null;
  }

  start() {
    // Get local IP address
    const interfaces = os.networkInterfaces();
    let localIp = "localhost";
    for (const name of Object.keys(interfaces)) {
      for (const iface of interfaces[name]) {
        if (iface.family === "IPv4" && !iface.internal) {
          localIp = iface.address;
          break;
        }
      }
      if (localIp !== "localhost") break;
    }
    this.app.listen(this.port, "0.0.0.0", () => {
      console.log(`
🚀 Vega Providers Dev Server Started!

📡 Server URL: http://localhost:${this.port}
📱 Mobile Test URL: http://${localIp}:${this.port}

💡 Usage:
  1. Run 'npm run auto' to to start the dev server ☑️
  2. Update vega app to use: http://${localIp}:${this.port}
  3. Test your providers!

🔄 Auto-rebuild: POST to /build to rebuild after changes
      `);

      // Check if build exists
      if (!fs.existsSync(this.distDir)) {
        console.log('\n⚠️  No build found. Run "node build.js" first!\n');
      }
    });
  }
}

// Start the server
const server = new DevServer();
server.start();
