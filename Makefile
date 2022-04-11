
TARGET = dist/main.js
RUN = node $(TARGET)

all: $(TARGET) run

run:
	$(RUN)

$(TARGET): src/*.ts
	tsc

compile: $(TARGET)

debug-all: $(TARGET)
	DEBUG=* $(RUN)

debug-writer: $(TARGET)
	DEBUG=writer.ts,writer.ts:* $(RUN)

.PHONY: all run compile debug-all debug-writer