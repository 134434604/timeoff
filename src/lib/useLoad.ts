import { useCallback, useEffect, useRef, useState } from "react";
import { messageOf } from "./api";

// Load one thing for a page: its data, a plain-English error, and a reload.
// A newer load always wins over an older one still in flight.
export function useLoad<T>(load: () => Promise<T>, deps: unknown[]) {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(true);
  const ticket = useRef(0);

  // eslint-disable-next-line react-hooks/exhaustive-deps
  const run = useCallback(load, deps);

  const reload = useCallback(async () => {
    const mine = ++ticket.current;
    setLoading(true);
    try {
      const value = await run();
      if (mine === ticket.current) {
        setData(value);
        setError("");
      }
    } catch (cause) {
      if (mine === ticket.current) setError(messageOf(cause));
    } finally {
      if (mine === ticket.current) setLoading(false);
    }
  }, [run]);

  useEffect(() => {
    void reload();
  }, [reload]);

  return { data, setData, error, loading, reload };
}
