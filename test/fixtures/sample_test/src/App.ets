import { ProfileCard } from "./components/ProfileCard.ets";
import { DialogPreview } from "./components/DialogPreview.ets";
import { StatsPanel } from "./components/StatsPanel.ets";
import { buildGreeting, SAMPLE_USERS } from "./utils/format.ts";

@Preview
@Entry
@Component
struct App {
  @State title: string = "Sample Test";
  @State selectedUser: string = SAMPLE_USERS[0].name;
  @State visitCount: number = 3;
  @StorageLink("activeSection") activeSection: string = "dashboard";

  @Watch("selectedUser")
  onSelectedUserChange(): void {}

  build() {
    const greeting = buildGreeting(this.selectedUser, this.visitCount);
    const profileCard = new ProfileCard({
      userName: this.selectedUser,
      userRole: "ArkTS Tester",
    });
    const dialogPreview = new DialogPreview();
    const statsPanel = new StatsPanel({
      totalUsers: SAMPLE_USERS.length,
      activeUsers: 2,
    });

    return {
      greeting,
      dialogPreview,
      profileCard,
      statsPanel,
    };
  }
}
