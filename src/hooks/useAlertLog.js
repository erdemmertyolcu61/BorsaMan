import { useState, useCallback } from 'react';

/**
 * useAlertLog - Manages alert log for display
 */
export function useAlertLog(advisor) {
  const [alerts, setAlerts] = useState([]);

  const addAlert = useCallback((alert) => {
    setAlerts(prev => [
      {
        id: Date.now(),
        timestamp: new Date(),
        ...alert,
      },
      ...prev,
    ].slice(0, 100)); // Keep last 100 alerts
  }, []);

  const clearAlerts = useCallback(() => {
    setAlerts([]);
  }, []);

  return {
    alerts,
    addAlert,
    clearAlerts,
  };
}
