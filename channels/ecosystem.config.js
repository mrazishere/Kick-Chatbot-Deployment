module.exports = {
  "apps": [
    {
      "name": "kick-mraiishere",
      "script": "/home/user/Kick-Chatbot-Deployment/channels/mraiishere.js",
      "node_args": "--expose-gc",
      "log_date_format": "YYYY-MM-DD HH:mm:ss",
      "max_memory_restart": "150M",
      "out_file": "/home/user/Kick-Chatbot-Deployment/logs/kick-mraiishere-out.log",
      "error_file": "/home/user/Kick-Chatbot-Deployment/logs/kick-mraiishere-err.log",
      "watch": [
        "/home/user/Kick-Chatbot-Deployment/channel-configs/mraiishere.json"
      ],
      "watch_delay": 2000,
      "ignore_watch": [
        "node_modules",
        "logs",
        "*.log"
      ],
      "watch_options": {
        "followSymlinks": false
      }
    },
    {
      "name": "kick-sukasblood",
      "script": "/home/user/Kick-Chatbot-Deployment/channels/sukasblood.js",
      "node_args": "--expose-gc",
      "log_date_format": "YYYY-MM-DD HH:mm:ss",
      "max_memory_restart": "150M",
      "out_file": "/home/user/Kick-Chatbot-Deployment/logs/kick-sukasblood-out.log",
      "error_file": "/home/user/Kick-Chatbot-Deployment/logs/kick-sukasblood-err.log",
      "watch": [
        "/home/user/Kick-Chatbot-Deployment/channel-configs/sukasblood.json"
      ],
      "watch_delay": 2000,
      "ignore_watch": [
        "node_modules",
        "logs",
        "*.log"
      ],
      "watch_options": {
        "followSymlinks": false
      }
    },
    {
      "name": "kick-mrazishere",
      "script": "/home/user/Kick-Chatbot-Deployment/channels/mrazishere.js",
      "node_args": "--expose-gc",
      "log_date_format": "YYYY-MM-DD HH:mm:ss",
      "max_memory_restart": "150M",
      "out_file": "/home/user/Kick-Chatbot-Deployment/logs/kick-mrazishere-out.log",
      "error_file": "/home/user/Kick-Chatbot-Deployment/logs/kick-mrazishere-err.log",
      "watch": [
        "/home/user/Kick-Chatbot-Deployment/channel-configs/mrazishere.json"
      ],
      "watch_delay": 2000,
      "ignore_watch": [
        "node_modules",
        "logs",
        "*.log"
      ],
      "watch_options": {
        "followSymlinks": false
      }
    }
  ]
}
