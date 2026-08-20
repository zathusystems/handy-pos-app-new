#!/bin/bash
# Post-install script for Handy POS
# Installs udev rules for thermal printer USB access

set -e

echo "[Handy POS] Installing udev rules for thermal printer access..."

# Install udev rules
if [ -f "/opt/handy-pos/99-thermal-printers.rules" ]; then
    sudo cp /opt/handy-pos/99-thermal-printers.rules /etc/udev/rules.d/99-thermal-printers.rules
    echo "[Handy POS] ✓ udev rules installed"
    
    # Reload udev rules
    sudo udevadm control --reload-rules
    sudo udevadm trigger
    echo "[Handy POS] ✓ udev rules reloaded"
else
    echo "[Handy POS] ⚠ udev rules file not found at /opt/handy-pos/99-thermal-printers.rules"
fi

# Add current user to lp group for printer access
if ! groups "$USER" | grep -q "\blp\b"; then
    echo "[Handy POS] Adding user to 'lp' group for printer access..."
    sudo usermod -a -G lp "$USER"
    echo "[Handy POS] ✓ User added to 'lp' group"
    echo "[Handy POS] ⚠ Please log out and log back in for group changes to take effect"
else
    echo "[Handy POS] ✓ User already in 'lp' group"
fi

echo "[Handy POS] Installation complete!"
