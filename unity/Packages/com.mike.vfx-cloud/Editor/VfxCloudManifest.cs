using System;
using UnityEngine;

namespace VfxCloud
{
    [Serializable]
    public class VfxCloudManifest
    {
        public string uri;
        public string type;
        public string slug;
        public int version;
        public string name;
        public string description;
        public string[] tags;
        public string[] style;
        public string category;
        public string license;
        public string visibility;
        public string mime;
        public int bytes;
        public string file_name;
        public string sha256;
        public string[] dependencies;
        public string download_url;
        public string preview_url;

        public string TargetPath => $"Assets/VFXCloud/{type}/{slug}/{file_name}";
    }
}
