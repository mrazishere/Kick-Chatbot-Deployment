#!/bin/bash
# Run this as root to add the /kpp nginx proxy block and reload nginx.

NGINX_CONF="/etc/nginx/sites-available/mr-ai.dev"

# Insert the /kpp location block before the existing /reversal block
sed -i '/# reversal — diabetes\/hypertension reversal journal/i \
    # kpp-dashboard — sukasblood KPP earnings dashboard\
    location /kpp {\
        proxy_pass http://localhost:3008;\
        proxy_http_version 1.1;\
        proxy_set_header Host $host;\
        proxy_set_header X-Real-IP $remote_addr;\
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;\
        proxy_set_header X-Forwarded-Proto $scheme;\
        proxy_set_header Upgrade $http_upgrade;\
        proxy_set_header Connection '"'"'upgrade'"'"';\
        proxy_cache_bypass $http_upgrade;\
        proxy_read_timeout 60;\
    }\
' "$NGINX_CONF"

nginx -t && systemctl reload nginx && echo "nginx reloaded OK"
