@CustomDialog
@Component
export struct DialogPreview {
  @State visible: boolean = true;

  build() {
    return this.visible;
  }
}
