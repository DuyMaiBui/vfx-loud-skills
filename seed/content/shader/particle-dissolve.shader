Shader "VFXCloud/Particle Dissolve"
{
    Properties
    {
        _BaseMap ("Texture", 2D) = "white" {}
        _BaseColor ("Color", Color) = (1,1,1,1)
        _NoiseMap ("Noise", 2D) = "gray" {}
        _Dissolve ("Dissolve", Range(0,1)) = 0
        _NoiseScale ("Noise Scale", Float) = 4
        _Softness ("Edge Softness", Range(0.001,0.5)) = 0.08
        _EdgeColor ("Edge Color", Color) = (1,0.6,0.1,1)
    }

    SubShader
    {
        Tags
        {
            "RenderType" = "TransparentCutout"
            "Queue" = "AlphaTest"
            "RenderPipeline" = "UniversalPipeline"
            "IgnoreProjector" = "True"
        }

        Blend SrcAlpha OneMinusSrcAlpha
        ZWrite Off
        Cull Off

        Pass
        {
            HLSLPROGRAM
            #pragma vertex vert
            #pragma fragment frag
            #include "Packages/com.unity.render-pipelines.universal/ShaderLibrary/Core.hlsl"

            struct Attributes { float4 positionOS : POSITION; float2 uv : TEXCOORD0; float4 color : COLOR; };
            struct Varyings { float4 positionCS : SV_POSITION; float2 uv : TEXCOORD0; float4 color : COLOR; };

            TEXTURE2D(_BaseMap); SAMPLER(sampler_BaseMap);
            TEXTURE2D(_NoiseMap); SAMPLER(sampler_NoiseMap);
            float4 _BaseMap_ST;
            half4 _BaseColor;
            half4 _EdgeColor;
            half _Dissolve;
            float _NoiseScale;
            half _Softness;

            Varyings vert (Attributes IN)
            {
                Varyings OUT;
                OUT.positionCS = TransformObjectToHClip(IN.positionOS.xyz);
                OUT.uv = TRANSFORM_TEX(IN.uv, _BaseMap);
                OUT.color = IN.color * _BaseColor;
                return OUT;
            }

            half4 frag (Varyings IN) : SV_Target
            {
                half4 tex = SAMPLE_TEXTURE2D(_BaseMap, sampler_BaseMap, IN.uv);
                half4 col = tex * IN.color;

                half noise = SAMPLE_TEXTURE2D(_NoiseMap, sampler_NoiseMap, IN.uv * _NoiseScale).r;
                half edge = noise - _Dissolve;
                half mask = smoothstep(0.0, _Softness, edge);
                col.a *= mask;

                half rim = smoothstep(-_Softness, 0.0, edge);
                col.rgb = lerp(col.rgb, _EdgeColor.rgb, rim * 0.6 * (1.0 - _Dissolve));
                clip(col.a - 0.01);
                return col;
            }
            ENDHLSL
        }
    }
}
