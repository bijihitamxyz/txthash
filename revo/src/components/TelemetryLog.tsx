'use client';

import React, { useState, useEffect, useMemo } from 'react';
import { useTradingStore, TelemetryItem } from '@/store/useTradingStore';
import { Terminal, Trash2, ChevronDown, ChevronUp } from 'lucide-react';

export const TelemetryLog: React.FC = () => {
  const [isMounted, setIsMounted] = useState(false);
  const [isCollapsed, setIsCollapsed] = useState(false);

  useEffect(() => {
    setIsMounted(true);
  }, []);

  const telemetryLogs = useTradingStore((s) => s.telemetryLogs);
  const clearTelemetry = useTradingStore((s) => s.clearTelemetry);

  const filteredLogs = useMemo(() => {
    return telemetryLogs.slice(0, 80);
  }, [telemetryLogs]);

  if (!isMounted) {
    return (
      <div className="bg-white border border-slate-200 rounded-xl overflow-hidden flex flex-col h-44 shadow-sm animate-pulse">
        <div className="bg-slate-50 px-4 py-2 border-b border-slate-200 flex items-center justify-between">
          <div className="flex items-center gap-2">
            <Terminal className="w-4 h-4 text-slate-400" />
            <span className="font-bold text-slate-500 text-xs uppercase tracking-wider">
              Live Execution Telemetry
            </span>
          </div>
        </div>
        <div className="flex-1 p-3 flex items-center justify-center text-slate-400 font-mono text-xs">
          Loading telemetry stream...
        </div>
      </div>
    );
  }

  const getCategoryColor = (cat: TelemetryItem['category']) => {
    switch (cat) {
      case 'ORDER':
        return 'text-emerald-700 bg-emerald-50 border-emerald-200';
      case 'SIGNAL':
        return 'text-sky-700 bg-sky-50 border-sky-200';
      case 'AI':
        return 'text-purple-700 bg-purple-50 border-purple-200';
      case 'TRAILING':
        return 'text-amber-800 bg-amber-50 border-amber-200';
      case 'RISK':
        return 'text-rose-700 bg-rose-50 border-rose-200';
      default:
        return 'text-slate-700 bg-slate-100 border-slate-200';
    }
  };

  return (
    <div className="bg-white border border-slate-200 rounded-xl overflow-hidden flex flex-col shadow-sm w-full max-w-full text-slate-900">
      {/* Telemetry Header */}
      <div className="bg-slate-50/80 px-3 py-2 sm:px-4 sm:py-2 border-b border-slate-200 flex flex-wrap items-center justify-between gap-2">
        <div className="flex items-center gap-2">
          <Terminal className="w-4 h-4 text-emerald-600 shrink-0" />
          <span className="font-bold text-slate-900 text-xs uppercase tracking-wider">
            Live Execution Telemetry
          </span>
          <span className="text-[10px] text-slate-500 font-mono">({filteredLogs.length})</span>
        </div>

        <div className="flex items-center gap-1.5 sm:gap-2 max-w-full overflow-x-auto">
          {/* Single ALL Tab */}
          <div className="flex items-center gap-1 bg-slate-100 p-0.5 rounded-lg border border-slate-200 text-[10px] font-mono shrink-0">
            <span className="px-2.5 py-0.5 rounded bg-indigo-600 text-white font-bold shadow-sm text-[9px] sm:text-[10px]">
              ALL
            </span>
          </div>

          <button
            type="button"
            onClick={clearTelemetry}
            className="p-1 rounded text-slate-400 hover:text-rose-600 hover:bg-slate-100 transition-colors cursor-pointer shrink-0"
            title="Clear logs"
          >
            <Trash2 className="w-3.5 h-3.5" />
          </button>

          {/* Collapsible Toggle */}
          <button
            type="button"
            onClick={() => setIsCollapsed(!isCollapsed)}
            className="p-1 rounded text-slate-400 hover:text-slate-800 hover:bg-slate-100 transition-colors cursor-pointer shrink-0"
            title={isCollapsed ? 'Expand Terminal' : 'Collapse Terminal'}
          >
            {isCollapsed ? <ChevronDown className="w-3.5 h-3.5" /> : <ChevronUp className="w-3.5 h-3.5" />}
          </button>
        </div>
      </div>

      {/* Terminal Viewport (Compact h-44) */}
      {!isCollapsed && (
        <div className="h-44 p-2.5 sm:p-3 overflow-y-auto space-y-1 font-mono text-[11px] bg-slate-50/50 text-slate-800">
          {filteredLogs.length === 0 ? (
            <div className="text-slate-400 italic py-6 text-center text-xs">
              Awaiting engine telemetry... Signal checks, risk thresholds, and execution updates stream here in real time.
            </div>
          ) : (
            filteredLogs.map((log) => {
              const timeStr = new Date(log.timestamp).toLocaleTimeString();
              return (
                <div key={log.id} className="flex items-start gap-1.5 sm:gap-2 leading-relaxed py-0.5 border-b border-slate-100">
                  <span className="text-slate-400 text-[10px] shrink-0">[{timeStr}]</span>
                  <span className="text-slate-600 font-bold shrink-0 text-[10px]">[{log.symbol}]</span>
                  <span className={`px-1.5 py-0.2 rounded border text-[9px] font-bold shrink-0 ${getCategoryColor(log.category)}`}>
                    {log.category}
                  </span>
                  <span className="break-all flex-1 text-slate-800">{log.message}</span>
                </div>
              );
            })
          )}
        </div>
      )}
    </div>
  );
};

export default TelemetryLog;
