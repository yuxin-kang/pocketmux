package io.crates.keyring

import android.content.Context

/**
 * JNI bridge required by android-native-keyring-store to initialize ndk-context.
 *
 * The native function name is part of the keyring crate's public Android
 * integration contract, so keep this package/class/companion shape stable.
 */
class Keyring {
  companion object {
    init {
      System.loadLibrary("pocketmux_native_lib")
    }

    external fun initializeNdkContext(context: Context)
  }
}
