# Mikrotik Billling Management by AJC - Nginx Deployment Guide

This guide details how to set up the Mikrotik Billling Management by AJC in a standard production environment, serving it from the `/var/www/html` directory using Nginx as a reverse proxy. This allows you to access the panel on the standard web port 80.

## Prerequisites

-   An Orange Pi or similar SBC running a Debian-based OS (like Armbian) with SSH access.
-   **Node.js v20.x, npm, and other essential tools.** The following steps will guide you through the installation.

### 1. Install Node.js and Essential Tools

This project requires a modern version of Node.js. The recommended way to install it on Armbian/Debian is by using the NodeSource repository.

**a. Update System Packages**

First, ensure your system's package list is up-to-date.
```bash
sudo apt update
sudo apt upgrade
```

**b. Add the NodeSource Repository**

Use `curl` to download and run the setup script for the recommended Node.js version. `curl` might not be installed, so we ensure it is.
```bash
sudo apt install -y curl
# This script adds the repository for Node.js v20.x (LTS)
curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash -
```

**c. Install Node.js, Git, Nginx, and Build Tools**

Now, install `nodejs` (which includes `npm`) along with the other required packages.
```bash
# `build-essential` is needed for some npm packages that compile from source.
# `nginx` is our reverse proxy.
# `git` is for cloning the repository.
sudo apt install -y nodejs git build-essential nginx
```

**d. Verify the Installation**

Check that Node.js and npm are installed correctly.
```bash
node -v
npm -v
```
You should see version numbers like `v20.x.x` and `10.x.x`.

### 2. Install PM2

`pm2` is a process manager that will keep the panel running as a background service. Install it globally using `npm`.
```bash
sudo npm install -g pm2
```

## Step 1: Prepare the Directory

1.  **Create the Directory:**
    The `/var/www/html` directory may already exist. This command ensures it's created if it's missing.
    ```bash
    sudo mkdir -p /var/www/html
    ```

2.  **Set Permissions:**
    Change ownership of the web root to your current user so you can clone into it without `sudo`.
    ```bash
    sudo chown -R $USER:$USER /var/www/html
    ```

## Step 2: Clone and Install the Application

1.  **Navigate and Clone:**
    ```bash
    cd /var/www/html
    git clone https://github.com/Djnirds1984/Mikrotik-Billing-Manager.git
    ```

2.  **Navigate into Project Directory:**
    ```bash
    cd Mikrotik-Billing-Manager
    ```

3.  **Install Dependencies & Build Frontend:**
    Run these commands from the project's **root directory**.
    ```bash
    # Install dependencies for the unified server
    npm install --prefix proxy
    
    # Install dev dependencies, build the UI, then remove dev dependencies
    npm install
    npm run build
    npm prune --production
    ```

4.  **Configure Gemini API Key (Optional):**
    Edit the `env.js` file and paste your Gemini API key.
    ```bash
    nano env.js
    ```
    Replace `"YOUR_GEMINI_API_KEY_HERE"` with your key, then save and exit (`Ctrl+X`, then `Y`, then `Enter`).

## Step 3: Start the Application with PM2

This command will run your application as a single background service.

1.  **Start the Server:**
    ```bash
    # Ensure any old versions are stopped
    pm2 delete all

    # Start the unified server (runs on localhost:3001)
    pm2 start ./proxy/server.js --name mikrotik-manager
    ```

2.  **Save the Process List:**
    This ensures `pm2` automatically restarts the app on server reboot.
    ```bash
    pm2 save
    ```

## Step 4: Configure Nginx as a Reverse Proxy

Nginx will listen on the public port 80 and forward all traffic to the Node.js server.

1.  **Edit the Default Configuration File:**
    ```bash
    sudo nano /etc/nginx/sites-available/default
    ```

2.  **Paste the Following Configuration:**
    Replace the **entire contents** of the file with this simplified configuration. It routes all requests, including API calls and WebSockets, to the single `mikrotik-manager` service.

    ```nginx
    server {
        listen 80;
        server_name <your_server_ip_or_domain>; # IMPORTANT: Replace with your server's IP or domain name
        client_max_body_size 10m;

        # Forward all traffic to the unified Node.js server on port 3001
        location / {
            proxy_pass http://localhost:3001;
            proxy_http_version 1.1;
            
            # Standard Proxy Headers
            proxy_set_header Host $host;
            proxy_set_header X-Real-IP $remote_addr;
            proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
            proxy_set_header X-Forwarded-Proto $scheme;
            
            # Headers required for WebSockets to function correctly
            proxy_set_header Upgrade $http_upgrade;
            proxy_set_header Connection "upgrade";
            proxy_cache_bypass $http_upgrade;
        }
    }
    ```
    Save and exit the file (`Ctrl+X`, then `Y`, then `Enter`).

3.  **Enable the Site and Restart Nginx:**
    ```bash
    # Test configuration syntax
    sudo nginx -t

    # Restart Nginx to apply the new configuration
    sudo systemctl restart nginx
    ```

4.  **Restart PM2 Application:**
    Restart the backend application to ensure it uses the new proxy headers from Nginx.
    ```bash
    pm2 restart all
    ```

## Step 5: Access Your Panel

You can now access your application directly by navigating to your server's IP address in your browser:

`http://<your_server_ip>`
(e.g., `http://192.168.1.10`)

## Troubleshooting

### Error: `Cannot find module '/var/www/html/Mikrotik-Billing-Manager/...'`

This error occurs if you rename the project directory *after* starting the application with `pm2`. The `pm2` service saves the full path and doesn't update automatically.

**Solution:**

1.  **Navigate to your new project directory:**
    ```bash
    cd /var/www/html/your-new-folder-name
    ```

2.  **Delete the old PM2 process:**
    ```bash
    pm2 delete all
    ```

3.  **Restart the application from the correct directory:**
    ```bash
    pm2 start ./proxy/server.js --name mikrotik-manager
    ```

4.  **Save the new process list:**
    ```bash
    pm2 save
    ```
