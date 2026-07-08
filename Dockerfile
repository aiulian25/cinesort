# CineSort Docker Container
# Professional media file organizer with TMDb and TVmaze integration
# Access via web browser at http://localhost:8888
#
# Python version: override at build time with --build-arg PYTHON_VERSION=3.12
# Supported range: 3.9 – 3.13  (3.11 is the tested default)

ARG PYTHON_VERSION=3.11
FROM python:${PYTHON_VERSION}-slim

LABEL maintainer="CineSort <app@cinesort.local>"
LABEL description="Professional media file organizer with smart metadata matching"
LABEL version="1.3.1"

# Set environment variables
ENV PYTHONUNBUFFERED=1 \
    PYTHONDONTWRITEBYTECODE=1 \
    PIP_NO_CACHE_DIR=1 \
    PIP_DISABLE_PIP_VERSION_CHECK=1 \
    CINESORT_HOST=0.0.0.0 \
    CINESORT_PORT=8888 \
    CINESORT_DATA_DIR=/data \
    PUID=1000 \
    PGID=1000

# Install system dependencies
RUN apt-get update && \
    apt-get install -y --no-install-recommends \
        ca-certificates \
        curl \
        gosu \
    && rm -rf /var/lib/apt/lists/*

# Create application directory
WORKDIR /app

# Copy requirements first for better layer caching
COPY requirements.txt .

# Install Python dependencies
RUN pip install --no-cache-dir -r requirements.txt

# Copy application code
COPY app/ ./app/

# Copy application icon
COPY app/CineSort.png ./app/

# Create non-root user and necessary directories
RUN groupadd -g 1000 cinesort && \
    useradd -u 1000 -g cinesort -s /bin/bash -m cinesort && \
    mkdir -p /data /media && \
    chown -R cinesort:cinesort /app /data /media

# Copy entrypoint script
COPY docker-entrypoint.sh /usr/local/bin/
RUN chmod +x /usr/local/bin/docker-entrypoint.sh

# Expose web UI port
EXPOSE 8888

# Health check - verify API is responding
HEALTHCHECK --interval=30s --timeout=10s --start-period=10s --retries=3 \
    CMD curl -f http://localhost:8888/ || exit 1

# Volume for persistent data
VOLUME ["/data", "/media"]

# Set entrypoint
ENTRYPOINT ["docker-entrypoint.sh"]

# Default command
CMD ["python", "-m", "uvicorn", "app.main:app", "--host", "0.0.0.0", "--port", "8888"]
