# 🚀 CineSort Deployment Guide

Complete step-by-step instructions for publishing CineSort to Docker Hub and GitHub.

---

## 📋 Prerequisites

Before you begin, ensure you have:
- ✅ Docker installed and running
- ✅ Docker Hub account (username: `aiulian25`)
- ✅ GitHub repository created: https://github.com/aiulian25/cinesort
- ✅ Git configured with your credentials

---

## 🐳 Step 1: Login to Docker Hub

```bash
docker login
# Enter username: aiulian25
# Enter password: [your Docker Hub password]
```

**Verify login**:
```bash
docker info | grep Username
```

---

## 🏗️ Step 2: Build the Docker Image

Navigate to your project directory:
```bash
cd /home/iulian/projects/renamer
```

Build the image with proper tags:
```bash
# Build with latest tag
docker build -t aiulian25/cinesort:latest .

# Also tag with version (recommended)
docker tag aiulian25/cinesort:latest aiulian25/cinesort:1.0.0
```

**Verify the build**:
```bash
docker images | grep cinesort
```

You should see:
```
aiulian25/cinesort   latest    [IMAGE ID]   [SIZE]   ~180MB
aiulian25/cinesort   1.0.0     [IMAGE ID]   [SIZE]   ~180MB
```

---

## 📤 Step 3: Push to Docker Hub

Push both tags to Docker Hub:

```bash
# Push latest tag
docker push aiulian25/cinesort:latest

# Push version tag
docker push aiulian25/cinesort:1.0.0
```

**Progress indicators**: You'll see upload progress for each layer.

**Verify on Docker Hub**:
1. Go to https://hub.docker.com/r/aiulian25/cinesort
2. Check that both tags (`latest` and `1.0.0`) are listed
3. Verify image size (~180MB)

---

## 🔄 Step 4: Test the Published Image

Before pushing to GitHub, verify users can pull and run the image:

```bash
# Stop current container
docker compose down

# Remove local image to force pull from Docker Hub
docker rmi aiulian25/cinesort:latest

# Test pull and run
docker compose pull
docker compose up -d

# Verify it's running
docker ps | grep cinesort
curl http://localhost:8888
```

**Expected result**: Container starts successfully and web UI is accessible.

---

## 📦 Step 5: Prepare Git Repository

Check what will be committed:

```bash
cd /home/iulian/projects/renamer
git status
```

**Files that SHOULD be included**:
- ✅ `app/` (source code)
- ✅ `Dockerfile`
- ✅ `.dockerignore`
- ✅ `docker-entrypoint.sh`
- ✅ `docker-compose.yml` (for end users)
- ✅ `docker-compose.dev.yml` (for developers)
- ✅ `requirements.txt`
- ✅ `README.md`
- ✅ `LICENSE`
- ✅ `.gitignore`
- ✅ `icon.png` (if exists)

**Files that should be EXCLUDED** (via .gitignore):
- ❌ `.venv/`
- ❌ `__pycache__/`
- ❌ `dist/`, `build/`
- ❌ `extracted/`, `decompiled/`
- ❌ `test_media/`
- ❌ `node_modules/`
- ❌ Internal docs (DOCKER_*.md)

Review excluded files:
```bash
git status --ignored
```

---

## 🔐 Step 6: Security Check

**CRITICAL**: Verify no sensitive data before pushing:

```bash
# Check for potential secrets
grep -r "password\|secret\|token" --include="*.py" --include="*.yml" --include="*.yaml" app/ docker-compose.yml

# Verify API keys are properly handled
grep -n "API_KEY" docker-compose.yml app/api/tmdb.py
```

**Expected**:
- ✅ `TMDB_API_KEY` is commented out in docker-compose.yml
- ✅ Default API key in `tmdb.py` is public (already embedded in FileBot)
- ✅ No passwords or private tokens

---

## 🚀 Step 7: Push to GitHub

Initialize git (if not already done):
```bash
cd /home/iulian/projects/renamer
git init
```

Configure repository:
```bash
# Set remote origin
git remote add origin https://github.com/aiulian25/cinesort.git

# Or if already set, verify:
git remote -v
```

Stage all files:
```bash
git add .
```

**Review what will be committed**:
```bash
git status
git diff --cached --stat
```

Commit:
```bash
git commit -m "Initial release: CineSort Docker container v1.0.0

Features:
- Smart media file detection and renaming
- TMDb and TVMaze metadata matching
- Modern web UI with folder browser
- Multi-select with checkboxes and Ctrl+A
- Docker container with PUID/PGID support
- Comprehensive documentation

Image: aiulian25/cinesort:latest (180MB)
"
```

Push to GitHub:
```bash
# Push to main branch
git branch -M main
git push -u origin main
```

---

## ✅ Step 8: Verify GitHub Repository

Visit https://github.com/aiulian25/cinesort and verify:

1. **Files are present**:
   - ✅ README.md displays correctly
   - ✅ LICENSE is visible
   - ✅ Source code in `app/`
   - ✅ Dockerfile and docker-compose.yml

2. **No sensitive data**:
   - ❌ No `.env` files
   - ❌ No build artifacts
   - ❌ No test media files

3. **README renders properly**:
   - Check badges, formatting, code blocks
   - Verify links work

---

## 🏷️ Step 9: Create GitHub Release (Optional)

Create a release tag for v1.0.0:

```bash
# Create and push tag
git tag -a v1.0.0 -m "Release v1.0.0 - Initial public release"
git push origin v1.0.0
```

Or create via GitHub web UI:
1. Go to https://github.com/aiulian25/cinesort/releases
2. Click "Create a new release"
3. Tag: `v1.0.0`
4. Title: `CineSort v1.0.0 - Initial Release`
5. Description: Copy from README features section
6. Publish release

---

## 🧪 Step 10: End-to-End User Test

Simulate a new user experience:

```bash
# Create test directory
mkdir -p ~/cinesort-test && cd ~/cinesort-test

# Download docker-compose.yml
wget https://raw.githubusercontent.com/aiulian25/cinesort/main/docker-compose.yml

# Edit and customize
nano docker-compose.yml

# Start container
docker compose up -d

# Verify
docker logs cinesort
curl http://localhost:8888

# Cleanup
docker compose down
cd ~ && rm -rf ~/cinesort-test
```

---

## 📊 Step 11: Update Docker Hub Description

1. Go to https://hub.docker.com/r/aiulian25/cinesort
2. Click "Edit" or "Manage Repository"
3. Add description:

```
CineSort - Professional media file organizer with intelligent metadata matching

Automatically detects, matches, and renames movies and TV shows using TMDb and TVMaze APIs.

Features:
• Smart detection and metadata matching
• Modern web UI with folder browser
• Multi-select and batch operations
• Rename history with undo
• Docker native (180MB, runs as non-root)
• Free APIs included

Documentation: https://github.com/aiulian25/cinesort
```

4. Add tags: `media`, `organizer`, `plex`, `jellyfin`, `tmdb`, `docker`

---

## 🎯 Quick Reference Commands

### For Future Updates:

**Build and push new version**:
```bash
# Update version
VERSION="1.0.1"

# Build
docker build -t aiulian25/cinesort:latest -t aiulian25/cinesort:$VERSION .

# Push
docker push aiulian25/cinesort:latest
docker push aiulian25/cinesort:$VERSION

# Git commit and push
git add .
git commit -m "Update to v$VERSION"
git push origin main
git tag -a v$VERSION -m "Release v$VERSION"
git push origin v$VERSION
```

**Quick rebuild and test**:
```bash
docker compose down
docker build -t aiulian25/cinesort:latest .
docker compose -f docker-compose.dev.yml up -d
docker logs -f cinesort
```

---

## 🐛 Troubleshooting Deployment

### Docker Push Fails

**Error**: `denied: requested access to the resource is denied`

**Solution**:
```bash
docker logout
docker login
# Re-enter credentials
```

### Git Push Fails

**Error**: `Authentication failed`

**Solution**:
```bash
# Use personal access token instead of password
# Generate at: https://github.com/settings/tokens
git remote set-url origin https://aiulian25:[TOKEN]@github.com/aiulian25/cinesort.git
```

### Image Size Too Large

**Check layers**:
```bash
docker history aiulian25/cinesort:latest
```

**Optimize** (if needed):
- Review .dockerignore
- Combine RUN commands
- Use multi-stage builds

---

## 🎉 Success Checklist

Before announcing the release, verify:

- ✅ Docker Hub image is public and pullable
- ✅ GitHub repository is public
- ✅ README displays correctly on GitHub
- ✅ docker-compose.yml downloads successfully
- ✅ End-to-end test passes
- ✅ No sensitive data in repository
- ✅ License file is present
- ✅ All documentation is accurate

---

## 📢 Announce Release

Share on:
- Reddit: r/selfhosted, r/docker, r/Plex, r/jellyfin
- Discord: Docker/Homelab communities
- GitHub Discussions (if enabled)

Sample announcement:
```
🎬 CineSort v1.0.0 Released!

Professional media file organizer with intelligent metadata matching.
Lightweight Docker container (180MB) with modern web UI.

Features:
• Automatic movie/TV show detection
• TMDb and TVMaze integration
• Folder browser with multi-select
• Plex/Jellyfin naming templates
• Rename history with undo

Quick start:
docker pull aiulian25/cinesort:latest

GitHub: https://github.com/aiulian25/cinesort
Docker Hub: https://hub.docker.com/r/aiulian25/cinesort
```

---

**🎊 Congratulations! Your project is now live!**
