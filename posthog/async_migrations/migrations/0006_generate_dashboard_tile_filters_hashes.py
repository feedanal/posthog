from functools import cached_property

import structlog
from sentry_sdk import capture_exception

from posthog.async_migrations.definition import AsyncMigrationDefinition, AsyncMigrationOperation, AsyncMigrationType
from posthog.models.dashboard_tile import DashboardTile
from posthog.redis import get_client

logger = structlog.get_logger(__name__)

REDIS_HIGHWATERMARK_KEY = "posthog.async_migrations.0006.highwatermark"


class Migration(AsyncMigrationDefinition):
    description = "ensure all dashboard tiles have filters hashes"

    depends_on = "0005_person_replacing_by_version"

    def is_required(self) -> bool:
        return DashboardTile.objects.filter(filters_hash=None).count() > 0

    @cached_property
    def operations(self):
        return [
            AsyncMigrationOperation(fn=self.set_high_watermark),
            AsyncMigrationOperation(fn=self.set_filters_hashes),
            AsyncMigrationOperation(fn=self.unset_high_watermark),
        ]

    def set_filters_hashes(self, query_id: str) -> None:
        try:
            should_continue = True
            while should_continue:
                should_continue = self.set_page_of_filters_hashes()
        except Exception as err:
            logger.error("0006_async_migration.error_setting_filters_hashes", exc=err, exc_info=True)
            capture_exception(err)

    def set_page_of_filters_hashes(self) -> bool:
        tiles_with_no_hash = DashboardTile.objects.filter(filters_hash=None).order_by("id")
        if tiles_with_no_hash.count() > 0:
            for tile in tiles_with_no_hash[0:100]:
                tile.save()  # which causes filters_hash to be set
            return True

        return False

    def get_high_watermark(self) -> int:
        high_watermark = get_client().get(REDIS_HIGHWATERMARK_KEY)
        return int(high_watermark) if high_watermark is not None else 0

    def set_high_watermark(self, query_id: str) -> None:
        if not self.get_high_watermark():
            count_of_tiles_without_filters_hash = DashboardTile.objects.filter(filters_hash=None).count()
            get_client().set(REDIS_HIGHWATERMARK_KEY, count_of_tiles_without_filters_hash)

    def unset_high_watermark(self, query_id: str) -> None:
        get_client().delete(REDIS_HIGHWATERMARK_KEY)

    def progress(self, migration_instance: AsyncMigrationType) -> int:
        current_count = DashboardTile.objects.filter(filters_hash=None).count()
        starting_count = self.get_high_watermark()
        return int((current_count / starting_count) * 100)
