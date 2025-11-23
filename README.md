# Mikrotik Billling Management by AJC

A modern, responsive web dashboard for managing your MikroTik routers, specifically designed to be lightweight enough to run on an Orange Pi or similar single-board computer. It features a real-time monitoring dashboard and a powerful AI Script Assistant powered by the Google Gemini API.

![Screenshot of the Mikrotik Billling Management by AJC Dashboard](./screenshot.png)

## Features

-   **Dashboard & Monitoring:** Real-time system info, resource usage (CPU/Memory), and live interface traffic graphs for both the panel host and the selected MikroTik router.
-   **AI Script Assistant:** Powered by Google Gemini, generates RouterOS terminal scripts from plain English descriptions.
-   **Full PPPoE & DHCP Suite:** Complete lifecycle management for user authentication, billing, and services.
-   **Hotspot Management:** Monitor active users, manage profiles, and edit login pages directly from the UI.
-   **Billing, Sales & Inventory:** A comprehensive suite for managing plans, processing payments, printing receipts, tracking sales, and managing stock.
-   **And much more:** See the full feature list in the `DEPLOYMENT_GUIDE.md`.

## Technical Architecture

This project uses a **single-server architecture** for simplicity and robustness. A single Node.js/Express server is responsible for:

1.  **Serving the Frontend UI:** Delivers all the static HTML, CSS, and JavaScript.
2.  **Handling Panel APIs:** Manages the database for users, settings, sales records, etc.
3.  **Proxying MikroTik APIs:** Acts as a secure backend that communicates directly with your MikroTik routers.

This unified model simplifies deployment and eliminates potential communication issues between multiple backend processes. The server runs on port **3001**.

---

## Deployment Guide (Orange Pi / Debian)

This is the recommended way to run the panel in a production environment.

### 1. Prerequisites

-   An Orange Pi or similar SBC running a Debian-based OS (like Armbian) with SSH access.
-   **Node.js v20.x or newer.**
-   **Essential Tools:** `git`, `pm2`, and `build-essential`.
    ```bash
    sudo apt-get update
    sudo apt-get install -y git build-essential curl
    # Install Node.js v20
    curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash -
    sudo apt-get install -y nodejs
    # Install PM2 process manager
    sudo npm install -g pm2
    ```
-   **(Optional) Gemini API Key**: For AI features, get a key from [Google AI Studio](https://aistudio.google.com/app/apikey) and paste it into the `env.js` file.

### 2. Installation & Startup

1.  **Clone the Repository:**
    ```bash
    git clone https://github.com/Djnirds1984/Mikrotik-Billing-Manager.git
    cd Mikrotik-Billing-Manager
    ```

2.  **Install Dependencies & Build Frontend:**
    Run these commands from the project's **root directory**.
    ```bash
    # Install dependencies for the unified server
    npm install --prefix proxy
    
    # Install build tools, build the UI, then remove dev dependencies
    npm install
    npm run build
    npm prune --production
    ```

3.  **Start with PM2:**
    This command starts the single server as a persistent, named process.
    ```bash
    # First, stop and delete any old running processes to ensure a clean start.
    pm2 delete all

    # Start the unified server (this runs everything on localhost:3001)
    pm2 start ./proxy/server.js --name mikrotik-manager
    ```

4.  **Save the Process List:**
    This ensures `pm2` will automatically restart your application on server reboot.
    ```bash
    pm2 save
    ```

5.  **Access the Panel:**
    Open your browser and navigate to `http://<your_orange_pi_ip>:3001`.

---

## Advanced Deployment with Nginx

For a more robust setup, you can run the panel on the standard web port 80 using Nginx as a reverse proxy.

**[See the full Nginx Deployment Guide here](./DEPLOYMENT_GUIDE.md)**

---

## Updating the Panel

You can update the panel directly from the "Updater" page in the UI. If you need to update manually via the command line:

1.  **Navigate to the project directory:**
    ```bash
    cd /path/to/Mikrotik-Billing-Manager
    ```
2.  **Pull the latest changes:**
    ```bash
    git pull
    ```
3.  **Re-install dependencies and rebuild the frontend:**
    ```bash
    npm install --prefix proxy
    npm install
    npm run build
    npm prune --production
    ```
4.  **Restart the server** to apply the updates:
    ```bash
    pm2 restart all
    ```

---

## Troubleshooting

### Error: `Cannot find module '/var/www/html/Mikrotik-Billing-Manager/...'`

This error occurs if you rename the project directory *after* starting the application with `pm2`. The `pm2` service saves the full path and doesn't update automatically.

**To fix this:**
1.  Navigate into your **new** project folder (e.g., `cd /path/to/your/new-folder-name`).
2.  Run `pm2 delete all` to clear the old processes.
3.  Run the `pm2 start ./proxy/server.js --name mikrotik-manager` command again.
4.  Run `pm2 save` to make the new path permanent.
