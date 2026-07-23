package com.solucionesmata.fccontrol;

import android.os.Bundle;
import com.getcapacitor.BridgeActivity;

public class MainActivity extends BridgeActivity {
    @Override
    public void onCreate(Bundle savedInstanceState) {
        registerPlugin(HikvisionCameraPlugin.class);
        super.onCreate(savedInstanceState);
    }
}
