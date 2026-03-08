import LogLevel, { Logger, LogLevelDesc } from "loglevel";
import chalk from "chalk";

const loggers: Record<string, Logger> = {};

export function getColoredLogger({ level = getDefaultLevel(), prefix = "" } = {}) {
    if (loggers[prefix]) {
        return loggers[prefix];
    }
    const coloredPrefix = prefix ? `${chalk.dim(prefix)} ` : "";
    const levelPrefix = {
        TRACE: chalk.dim("[TRACE]"),
        DEBUG: chalk.cyan("[DEBUG]"),
        INFO: chalk.blue("[INFO]"),
        WARN: chalk.yellow("[WARN]"),
        ERROR: chalk.red("[ERROR]"),
    };

    const logger = LogLevel.getLogger(`${prefix}-logger`);

    // this is the plugin "api"
    const originalFactory = logger.methodFactory;
    logger.methodFactory = methodFactory;

    const originalSetLevel = logger.setLevel;
    logger.setLevel = setLevel;
    logger.setLevel(level);
    loggers[prefix] = logger;
    return logger;

    function methodFactory(
        methodName: string,
        level: LogLevel.LogLevelNumbers,
        loggerName: string | symbol
    ): LogLevel.LoggingMethod {
        // const { 0: logLevel } = factoryArgs;
        const name = methodName.toUpperCase() as
            | "TRACE"
            | "DEBUG"
            | "INFO"
            | "WARN"
            | "ERROR";
        const rawMethod = originalFactory(methodName, level, loggerName);
        return (...args: any[]) =>
            rawMethod(`${coloredPrefix}${levelPrefix[name]}:`, ...args);
    }

    function setLevel(levelToSetTo: LogLevelDesc) {
        const persist = false; // uses browser localStorage
        return originalSetLevel.call(logger, levelToSetTo, persist);
    }
}

function getDefaultLevel(): LogLevelDesc {
    const { LOG_LEVEL: logLevel } = process.env;
    if (logLevel === "undefined" || !logLevel) {
        return "warn";
    }
    return logLevel as LogLevelDesc;
}
