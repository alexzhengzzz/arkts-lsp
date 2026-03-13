import { shortLabel } from "../utils/format.ts";

@Component
export struct ProfileCard {
  @State userName: string = "Guest";
  @Prop userTag: string = "sample";
  @State userRole: string = "Visitor";

  getSummary(): string {
    return `${shortLabel(this.userName)} [${this.userTag}] - ${this.userRole}`;
  }

  build() {
    return this.getSummary();
  }
}
