"""SafeNest Raspberry Pi entry point."""
import argparse

import config
from mqtt_receiver import MQTTReceiver
from safenest_app import SafeNestApp


def main():
    parser = argparse.ArgumentParser(description="SafeNest rule-based risk detection MVP")
    parser.add_argument("--db", default=config.DATABASE_PATH, help="SQLite path")
    parser.add_argument("--run-tests", action="store_true", help="run sensor-free demo scenarios")
    args = parser.parse_args()

    if args.run_tests:
        from demo_scenarios import run_all
        run_all()
        return

    from database import Database
    app = SafeNestApp(database=Database(args.db))
    receiver = MQTTReceiver(app.handle_payload)
    print("SafeNest started. Ctrl+C to stop.")
    try:
        receiver.start(blocking=True)
    except KeyboardInterrupt:
        print("Stopping SafeNest.")
    finally:
        receiver.stop()
        app.database.close()


if __name__ == "__main__":
    main()

